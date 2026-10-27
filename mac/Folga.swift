// Folga.app: o app de barra de menus do Mac (plano 3, ADR 0007). Compilado por scripts/mac-app.mjs com
// `swiftc -O`, sem Xcode.
//   Folga             o app: ícone na barra, sobe e vigia o servidor (node de dentro do bundle)
//   Folga --version   "folga <versão>" (o check compara com o package.json)
//   Folga --selftest  casos puros; sai 0/1
//   Folga --notify   posta um aviso (FOLGA_TOAST_TITLE/FOLGA_TOAST_BODY do ambiente) e sai; não sobe o app. Sai ≠ 0 se o
//                    macOS não deixar (o servidor então cai para o osascript)
//   Folga --login     como sem argumento, mas de LaunchAgent (Abrir com o Mac): só o ícone, nunca abre a janela
import AppKit
import Foundation
import os
import Security
import UserNotifications
import WebKit

let bundleId = "local.folga.mac"
let logger = Logger(subsystem: "local.folga.mac", category: "app")
let port = 4780
let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")

// MARK: - Regras puras (cobertas pelo --selftest)

/// Espera antes de subir o servidor de novo: 1, 2, 4, 8, 16 s; a 6ª queda em 10 min → nil (desiste).
/// `crashes` = horas das quedas da sequência atual, a mais nova por último.
func nextDelay(crashes: [Date], now: Date) -> TimeInterval? {
  let recentes = crashes.filter { now.timeIntervalSince($0) <= 600 }.count
  if recentes == 0 { return 0 }
  if recentes > 5 { return nil }
  return pow(2, Double(recentes - 1))
}

/// Registra uma queda. Servidor que ficou 5 min ou mais no ar zera a sequência.
func afterCrash(_ crashes: [Date], upSince: Date, now: Date) -> [Date] {
  now.timeIntervalSince(upSince) >= 300 ? [now] : crashes + [now]
}

/// Só o node de dentro do bundle (caminho relativo a Contents/Resources, gravado no folga.json). Nada de
/// /opt/homebrew, /usr/local ou ~/.nvm: pasta gravável pelo usuário deixaria trocar o código que o app roda.
/// Exige executável e `--version` ≥ 24.
func findNode(recorded: String, resources: URL = resources) -> String? {
  if recorded.isEmpty || recorded.hasPrefix("/") { return nil }
  // links resolvidos dos dois lados: um link dentro de Resources apontando para fora não passa
  let base = resources.resolvingSymlinksInPath().standardizedFileURL.path
  let path = resources.appendingPathComponent(recorded).resolvingSymlinksInPath().standardizedFileURL.path
  guard path.hasPrefix(base + "/"), FileManager.default.isExecutableFile(atPath: path) else { return nil }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = ["--version"]
  p.environment = [:]
  let out = Pipe()
  p.standardOutput = out
  p.standardError = FileHandle.nullDevice
  guard (try? p.run()) != nil else { return nil }
  p.waitUntilExit()
  let v = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  let major = Int(v.dropFirst().prefix { $0.isNumber }) ?? 0
  return p.terminationStatus == 0 && v.hasPrefix("v") && major >= 24 ? path : nil
}

/// Pasta do usuário pela conta do sistema (getpwuid), nunca pelo HOME do ambiente, que quem lança o app escolhe.
func homeDir() -> String {
  if let pw = getpwuid(getuid()), let d = pw.pointee.pw_dir { return String(cString: d) }
  return NSHomeDirectory()
}

/// Pasta temporária do usuário pelo sistema (confstr), nunca pelo TMPDIR do ambiente, que quem lança o app escolhe.
func userTempDir() -> String {
  var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
  if confstr(_CS_DARWIN_USER_TEMP_DIR, &buf, buf.count) > 0 { return String(cString: buf) }
  return "/tmp"
}

/// Ambiente do servidor, montado do zero: nada de NODE_OPTIONS, NODE_*, DYLD_* nem do resto do ambiente do app.
/// HOME vem da conta (homeDir). Entradas do PATH sem "/" na frente são relativas a Contents/Resources.
func childEnv(from env: [String: String], appPath: String, path: String, resources: URL = resources) -> [String: String] {
  var out: [String: String] = [:]
  for k in ["LANG", "USER", "LOGNAME"] { if let v = env[k] { out[k] = v } }
  out["HOME"] = homeDir()
  out["TMPDIR"] = userTempDir()
  out["FOLGA_APP"] = "1"
  out["FOLGA_APP_PATH"] = appPath
  out["PATH"] = path.split(separator: ":").map { $0.hasPrefix("/") ? String($0) : resources.appendingPathComponent(String($0)).path }
    .joined(separator: ":")
  return out
}

/// server.log em acréscimo, zerado acima de 1 MB (como o launch.mjs). Nunca segue link: um link plantado no
/// lugar do log faria o Folga escrever em outro arquivo do usuário. A pasta
/// também precisa ser pasta de verdade (lstat). Qualquer falha → sem log (melhor que não subir).
/// ponytail: só o último componente e a pasta-mãe são conferidos; pastas acima são do próprio usuário.
func openLog(at path: String) -> FileHandle {
  var st = stat()
  let dir = (path as NSString).deletingLastPathComponent
  guard lstat(dir, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR else {
    logger.error("server.log: a pasta não é uma pasta de verdade; sem log")
    return FileHandle.nullDevice
  }
  let fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard fd >= 0 else {
    logger.error("server.log não abriu (errno \(errno, privacy: .public)); sem log")
    return FileHandle.nullDevice
  }
  if fstat(fd, &st) != 0 || (st.st_mode & S_IFMT) != S_IFREG {
    close(fd)
    logger.error("server.log não é arquivo comum; sem log")
    return FileHandle.nullDevice
  }
  _ = fchmod(fd, 0o600)   // log 0644 de antes da correção: o O_CREAT só vale para arquivo novo
  if st.st_size > 1_000_000 { _ = ftruncate(fd, 0) }
  return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
}

/// A janela só navega no próprio servidor: http, 127.0.0.1, a porta do Folga, sem usuário/senha na URL.
/// Qualquer outra coisa (localhost, outra porta, https, file:, javascript:, about:, data:) fica fora.
func allowedURL(_ url: URL, port: Int) -> Bool {
  url.scheme == "http" && url.host == "127.0.0.1" && url.port == port && url.user == nil && url.password == nil
}

/// Texto da barra (decisão 13): memória usada · disco livre, "62% · 39 GB" (GB decimal, como o Finder).
/// Sem servidor → "Folga".
/// Falha de carga que é "servidor ainda subindo / caiu" (vale tentar de novo). Cancelamento pela nossa própria
/// política (WebKitErrorDomain 102, NSURLErrorCancelled) e o resto não são: recarregar perderia a tela do usuário.
func servidorFora(_ error: Error) -> Bool {
  let e = error as NSError
  return e.domain == NSURLErrorDomain
    && [NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotFindHost].contains(e.code)
}

/// Apps que o servidor já classificou como parados (só `state == "idle"`; `in_use`, `protected` — que inclui
/// `__self` e o app em primeiro plano — e item sem chave ficam fora), maior memória primeiro.
func idleApps(_ state: [String: Any]) -> [(key: String, name: String, bytes: Int64)] {
  ((state["apps"] as? [[String: Any]]) ?? []).compactMap { a in
    guard a["state"] as? String == "idle", let key = a["key"] as? String, !key.isEmpty else { return nil }
    return (key, a["name"] as? String ?? key, (a["privateWorkingSet"] as? NSNumber)?.int64Value ?? 0)
  }.sorted { $0.bytes > $1.bytes }
}

/// Mesmo formato do `size()` da interface: "180 MB", "1,5 GB" (base 1024, vírgula, espaço não separável).
func tamanho(_ b: Int64) -> String {
  let gb = 1_073_741_824.0, mb = 1_048_576.0
  let f = NumberFormatter()
  f.locale = Locale(identifier: "pt_BR")
  if Double(b) >= gb {
    f.minimumFractionDigits = 1; f.maximumFractionDigits = 1
    return "\(f.string(from: NSNumber(value: Double(b) / gb)) ?? "?")\u{a0}GB"
  }
  f.maximumFractionDigits = 0
  return "\(f.string(from: NSNumber(value: max(0, Double(b)) / mb)) ?? "?")\u{a0}MB"
}

/// Botões do alerta de liberar: "Cancelar" é o 1º (Return), "Fechar" o 2º (sem tecla). Só o 2º fecha apps.
func confirmouFechar(_ r: NSApplication.ModalResponse) -> Bool { r == .alertSecondButtonReturn }

/// Título e texto do alerta de resultado. `status == nil` = sem resposta depois do POST (tempo esgotado, conexão
/// caiu): a liberação pode ter acontecido, então manda ver o Registro. R08: o que voltou é o disponível depois
/// menos o de antes, nunca a soma dos apps.
func resultadoLiberar(status: Int?, corpo: [String: Any]) -> (titulo: String, texto: String) {
  guard let status else { return ("Não deu para confirmar o resultado: veja o Registro", "A liberação pode ter acontecido.") }
  guard status == 200 else { return ("Não deu para liberar agora", corpo["erro"] as? String ?? "Erro \(status).") }
  guard let depois = (corpo["availAfter"] as? NSNumber)?.int64Value, let antes = (corpo["availBefore"] as? NSNumber)?.int64Value else {
    return ("Liberação feita; veja o Registro", "")
  }
  let volta = depois - antes
  return volta > 0 ? ("\(tamanho(volta)) liberados", "Medido antes e depois de fechar.")
    : ("Nada voltou para a memória", "Os apps podem ter pedido para salvar ou continuam abertos.")
}

/// Decisão 18: só a memória — "81% · 34 GB" ficava escondido atrás do notch.
func statusText(memLoad: Int?) -> String {
  guard let m = memLoad else { return "Folga" }
  return "\(m)%"
}

/// Decisão 18: o disco livre mora no menu (aberto ao clicar), não no título.
func discoLivreTexto(_ bytes: Int64?) -> String {
  guard let b = bytes else { return "Disco livre: —" }
  return "Disco livre: \(Int((Double(b) / 1e9).rounded())) GB"
}

/// "2 avisos" do menu: só os ativos; em "só críticos" (R27, mesma regra do selo da tela) só os críticos.
/// Item sem severity conhecida não conta. Zero → nil (o item some).
func avisosTexto(_ lista: [[String: Any]], soCriticos: Bool) -> String? {
  let n = lista.filter { w in
    guard w["active"] as? Bool == true, let sev = w["severity"] as? String, ["critico", "atencao", "info"].contains(sev) else { return false }
    return !soCriticos || sev == "critico"
  }.count
  return n == 0 ? nil : n == 1 ? "1 aviso" : "\(n) avisos"
}

/// Decisão 17: o Folga não pede Acesso Total ao Disco. Lixeira legível = alguém ligou a permissão mesmo assim, e o
/// menu avisa para desligar. Só abrir de verdade conta: pasta negada, inexistente ou outro erro → false (sem aviso).
func hasFullDiskAccess(trash: String = homeDir() + "/.Trash") -> Bool {
  guard let d = opendir(trash) else { return false }
  closedir(d)
  return true
}

/// Texto do aviso do menu: só texto, sem link para os Ajustes (nada que convide a ligar).
let avisoAcessoTotal = "O Folga está com Acesso Total ao Disco — desligue em Ajustes (não é necessário)"

/// Item do menu quando os avisos do Folga não chegam: só texto, sem link (quem muda Ajustes é o usuário).
let avisoNotificacoes = "Notificações do Folga desligadas — ligue em Ajustes do Sistema › Notificações › Folga"
let avisoNotificacoesPendentes = "Notificações do Folga ainda não autorizadas"
/// Texto do item pelo código do `notifyExit`: 0 → nenhum · 3 → neutro (ainda não perguntado) · outro → desligadas.
func avisoNotificacoesTexto(_ codigo: Int32) -> String? {
  codigo == 0 ? nil : codigo == 3 ? avisoNotificacoesPendentes : avisoNotificacoes
}

/// Código de saída do `--notify` pelo estado das notificações: 0 entrega · 3 ainda não perguntado · 4 recusado.
/// Autorizado com alertas desligados não conta como entregue (o aviso iria só para a Central, mudo).
func notifyExit(status: UNAuthorizationStatus, alert: UNNotificationSetting) -> Int32 {
  switch status {
  case .authorized, .provisional: return alert == .enabled ? 0 : 4
  case .notDetermined: return 3
  default: return 4
  }
}

/// A instância principal pede autorização se ainda não está autorizado e ainda não pediu para este build.
/// Não exige `.notDetermined`: para um cliente que o usernoted nunca aceitou o estado pode vir `.denied` sem
/// nunca ter havido pedido na tela — esperar `.notDetermined` deixava o Folga sem pedir nunca.
func deveSolicitar(status: UNAuthorizationStatus, jaPediuNesteBuild: Bool) -> Bool {
  status != .authorized && !jaPediuNesteBuild
}

enum Lancamento: Equatable { case versao, selftest, notificar, rodar(login: Bool), uso }
/// Argumentos (sem o nome do programa). `--login` vale sozinho: é o que o LaunchAgent passa (decisão 15).
func lancamento(_ args: [String]) -> Lancamento {
  switch args.first {
  case nil: return .rodar(login: false)
  case "--version": return .versao
  case "--selftest": return .selftest
  case "--notify" where args.count == 1: return .notificar
  case "--login" where args.count == 1: return .rodar(login: true)
  default: return .uso
  }
}

func selftest() -> Int32 {
  var falhas = 0
  func caso(_ nome: String, _ ok: Bool) {
    if !ok { falhas += 1; FileHandle.standardError.write(Data("FALHOU: \(nome)\n".utf8)) }
  }
  caso("versão lida do Info.plist", version?.isEmpty == false)
  caso("lancamento: sem argumento e --login rodam o app", lancamento([]) == .rodar(login: false) && lancamento(["--login"]) == .rodar(login: true))
  caso("lancamento: --version, --selftest e o resto", lancamento(["--version"]) == .versao && lancamento(["--selftest"]) == .selftest
       && lancamento(["--notify"]) == .notificar && lancamento(["--notify", "x"]) == .uso && lancamento(["--login", "x"]) == .uso && lancamento(["--x"]) == .uso)

  let t0 = Date(timeIntervalSince1970: 1_000_000)
  var quedas: [Date] = []
  var esperas: [TimeInterval?] = []
  for i in 0..<6 {
    let agora = t0.addingTimeInterval(Double(i) * 10)
    quedas = afterCrash(quedas, upSince: agora.addingTimeInterval(-5), now: agora)
    esperas.append(nextDelay(crashes: quedas, now: agora))
  }
  caso("nextDelay: 1, 2, 4, 8, 16 s", esperas.prefix(5).map { $0 ?? -1 } == [1, 2, 4, 8, 16])
  caso("nextDelay: 6ª queda em 10 min desiste", esperas[5] == nil)
  caso("nextDelay: quedas de mais de 10 min atrás não contam",
       nextDelay(crashes: quedas, now: t0.addingTimeInterval(50 + 601)) == 0)
  let depois = t0.addingTimeInterval(1000)
  let zerou = afterCrash(quedas, upSince: depois.addingTimeInterval(-301), now: depois)
  caso("afterCrash: 5 min no ar zera a sequência", zerou == [depois] && nextDelay(crashes: zerou, now: depois) == 1)

  caso("findNode: caminho inexistente → nil", findNode(recorded: "folga/bin/nao-existe") == nil)
  caso("findNode: absoluto (fora do bundle) → nil", findNode(recorded: "/bin/sh") == nil)
  caso("findNode: escapar do bundle com .. → nil", findNode(recorded: "../MacOS/Folga") == nil)
  caso("findNode: o node de dentro do bundle", findNode(recorded: "folga/bin/node") != nil)

  let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("folga-selftest-\(getpid())")
  let fora = tmp.appendingPathComponent("fora")
  let res = tmp.appendingPathComponent("Resources")
  try? FileManager.default.createDirectory(at: fora, withIntermediateDirectories: true)
  try? FileManager.default.createDirectory(at: res.appendingPathComponent("folga/bin"), withIntermediateDirectories: true)
  try? FileManager.default.createSymbolicLink(atPath: res.appendingPathComponent("folga/bin/node").path,
                                              withDestinationPath: Bundle.main.resourceURL!.appendingPathComponent("folga/bin/node").path)
  caso("findNode: link dentro de Resources apontando para fora → nil", findNode(recorded: "folga/bin/node", resources: res) == nil)

  let alvo = fora.appendingPathComponent("protegido.txt")
  FileManager.default.createFile(atPath: alvo.path, contents: Data("intacto".utf8))
  let logLink = tmp.appendingPathComponent("server.log")
  try? FileManager.default.createSymbolicLink(atPath: logLink.path, withDestinationPath: alvo.path)
  let h = openLog(at: logLink.path)
  h.write(Data("vazou".utf8))
  caso("openLog: link no lugar do log não é seguido", h === FileHandle.nullDevice
       && (try? String(contentsOf: alvo, encoding: .utf8)) == "intacto")
  let real = tmp.appendingPathComponent("real.log")
  FileManager.default.createFile(atPath: real.path, contents: Data(count: 1_000_001))
  let hr = openLog(at: real.path)
  hr.write(Data("x".utf8))
  try? hr.close()
  caso("openLog: arquivo comum acima de 1 MB é zerado e recebe o acréscimo",
       (try? FileManager.default.attributesOfItem(atPath: real.path)[.size] as? Int) == 1)
  let antigo = tmp.appendingPathComponent("antigo.log")
  FileManager.default.createFile(atPath: antigo.path, contents: Data("x".utf8), attributes: [.posixPermissions: 0o644])
  try? openLog(at: antigo.path).close()
  caso("openLog: log 0644 de antes fica 0600",
       (try? FileManager.default.attributesOfItem(atPath: antigo.path)[.posixPermissions] as? Int) == 0o600)
  try? FileManager.default.removeItem(at: tmp)

  let env = childEnv(from: ["HOME": "/Users/v", "LANG": "pt_BR.UTF-8", "NODE_OPTIONS": "--require /tmp/x.js",
                            "DYLD_INSERT_LIBRARIES": "/tmp/x.dylib", "TMPDIR": "/tmp/plantado", "NODE_PATH": "/tmp", "SECRET": "s"],
                     appPath: "/A/Folga.app", path: "folga/bin:/usr/bin", resources: URL(fileURLWithPath: "/A/Folga.app/Contents/Resources"))
  caso("childEnv: só o permitido", Set(env.keys) == ["HOME", "LANG", "TMPDIR", "FOLGA_APP", "FOLGA_APP_PATH", "PATH"])
  caso("childEnv: HOME do sistema (getpwuid), nunca o do ambiente", env["HOME"] == homeDir() && env["HOME"] != "/Users/v")
  caso("childEnv: TMPDIR do sistema (confstr), nunca o do ambiente", env["TMPDIR"] == userTempDir() && env["TMPDIR"] != "/tmp/plantado")
  caso("childEnv: sem NODE_OPTIONS nem DYLD_INSERT_LIBRARIES", env["NODE_OPTIONS"] == nil && env["DYLD_INSERT_LIBRARIES"] == nil)
  caso("childEnv: PATH resolvido dentro do bundle", env["PATH"] == "/A/Folga.app/Contents/Resources/folga/bin:/usr/bin")
  caso("childEnv: FOLGA_APP=1 e FOLGA_APP_PATH", env["FOLGA_APP"] == "1" && env["FOLGA_APP_PATH"] == "/A/Folga.app")

  let ativo: (String?, Bool) -> [String: Any] = { sev, on in sev == nil ? ["active": on] : ["severity": sev!, "active": on] }
  caso("avisosTexto: lista vazia → nil", avisosTexto([], soCriticos: false) == nil)
  caso("avisosTexto: um atencao → 1 aviso", avisosTexto([ativo("atencao", true)], soCriticos: false) == "1 aviso")
  caso("avisosTexto: dois ativos + um inativo → 2 avisos", avisosTexto([ativo("atencao", true), ativo("critico", true), ativo("critico", false)], soCriticos: false) == "2 avisos")
  caso("avisosTexto: soCriticos e só atencao → nil", avisosTexto([ativo("atencao", true)], soCriticos: true) == nil)
  caso("avisosTexto: soCriticos conta o critico", avisosTexto([ativo("atencao", true), ativo("critico", true)], soCriticos: true) == "1 aviso")
  caso("avisosTexto: sem severity não conta", avisosTexto([ativo(nil, true)], soCriticos: false) == nil)

  let porta = 4780
  caso("allowedURL aceita /#avisos", allowedURL(URL(string: "http://127.0.0.1:4780/#avisos")!, port: porta))
  for ok in ["http://127.0.0.1:4780/", "http://127.0.0.1:4780/#/arquivos", "http://127.0.0.1:4780/assets/x.js"] {
    caso("allowedURL aceita \(ok)", allowedURL(URL(string: ok)!, port: porta))
  }
  for nao in ["http://localhost:4780/", "http://127.0.0.1:4781/", "https://127.0.0.1:4780/", "http://127.0.0.1.evil.com:4780/",
              "http://evil.com/?h=127.0.0.1:4780", "file:///etc/hosts", "javascript:alert(1)", "about:blank", "data:text/html,x",
              "http://127.0.0.1:4780@evil.com/", "http://u@127.0.0.1:4780/"] {
    caso("allowedURL recusa \(nao)", !allowedURL(URL(string: nao)!, port: porta))
  }
  for (dom, cod, esperado) in [(NSURLErrorDomain, NSURLErrorCannotConnectToHost, true), (NSURLErrorDomain, NSURLErrorNetworkConnectionLost, true),
                                (NSURLErrorDomain, NSURLErrorTimedOut, true), (NSURLErrorDomain, NSURLErrorCannotFindHost, true),
                                (NSURLErrorDomain, NSURLErrorCancelled, false), ("WebKitErrorDomain", 102, false),
                                (NSURLErrorDomain, NSURLErrorBadURL, false)] {
    caso("servidorFora(\(dom) \(cod)) = \(esperado)", servidorFora(NSError(domain: dom, code: cod)) == esperado)
  }
  let estadoTeste = try! JSONSerialization.jsonObject(with: Data("""
    {"memLoad": 70, "apps": [
      {"key": "com.apple.preview", "name": "Prévia", "privateWorkingSet": 80000000, "state": "idle"},
      {"key": "com.apple.textedit", "name": "TextEdit", "privateWorkingSet": 100000000, "state": "idle"},
      {"key": "com.google.chrome", "name": "Google Chrome", "privateWorkingSet": 900000000, "state": "in_use"},
      {"key": "__self", "name": "Folga", "privateWorkingSet": 70000000, "state": "protected"},
      {"key": "com.apple.terminal", "name": "Terminal", "privateWorkingSet": 50000000, "state": "protected"},
      {"name": "Sem chave", "privateWorkingSet": 999000000, "state": "idle"}
    ]}
    """.utf8)) as! [String: Any]
  let parados = idleApps(estadoTeste)
  caso("idleApps: só idle, maior primeiro", parados.map(\.key) == ["com.apple.textedit", "com.apple.preview"])
  caso("idleApps: nome e bytes", parados.first?.name == "TextEdit" && parados.first?.bytes == 100_000_000)
  caso("idleApps: estado sem apps → vazio", idleApps(["memLoad": 50]).isEmpty)
  caso("tamanho: 180 MB e 1,5 GB", tamanho(180 * 1_048_576) == "180\u{a0}MB" && tamanho(1_610_612_736) == "1,5\u{a0}GB")

  caso("alerta: 1º botão (Cancelar/Return) não fecha", !confirmouFechar(.alertFirstButtonReturn))
  caso("alerta: 2º botão (Fechar) fecha", confirmouFechar(.alertSecondButtonReturn))
  caso("alerta: Esc/abort não fecha", !confirmouFechar(.abort) && !confirmouFechar(.stop))
  caso("resultado: sem resposta → veja o Registro", resultadoLiberar(status: nil, corpo: [:]).titulo == "Não deu para confirmar o resultado: veja o Registro")
  caso("resultado: 200 sem números → veja o Registro", resultadoLiberar(status: 200, corpo: ["results": []]).titulo == "Liberação feita; veja o Registro")
  caso("resultado: R08 depois − antes", resultadoLiberar(status: 200, corpo: ["availBefore": 1_000_000_000, "availAfter": 1_188_743_680]).titulo == "180\u{a0}MB liberados")
  caso("resultado: nada voltou", resultadoLiberar(status: 200, corpo: ["availBefore": 5, "availAfter": 5]).titulo == "Nada voltou para a memória")
  caso("resultado: 409 mostra o erro do servidor", resultadoLiberar(status: 409, corpo: ["erro": "app protegido"]).texto == "app protegido")
  caso("statusText sem servidor → Folga", statusText(memLoad: nil) == "Folga")
  let semAcesso = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("folga-fda-\(getpid())")
  try? FileManager.default.createDirectory(at: semAcesso, withIntermediateDirectories: true)
  caso("hasFullDiskAccess: pasta legível → true (avisa)", hasFullDiskAccess(trash: semAcesso.path))
  chmod(semAcesso.path, 0)
  caso("hasFullDiskAccess: pasta negada → false (sem aviso)", !hasFullDiskAccess(trash: semAcesso.path))
  chmod(semAcesso.path, 0o700)
  try? FileManager.default.removeItem(at: semAcesso)
  caso("hasFullDiskAccess: pasta inexistente → false (sem aviso)", !hasFullDiskAccess(trash: semAcesso.path))
  caso("aviso: manda desligar, sem link nem caminho dos Ajustes", avisoAcessoTotal.contains("desligue")
       && !avisoAcessoTotal.contains("Privacy") && !avisoAcessoTotal.contains("›") && !avisoAcessoTotal.contains("://"))
  caso("notifyExit: autorizado com alertas → 0", notifyExit(status: .authorized, alert: .enabled) == 0)
  caso("notifyExit: provisório com alertas → 0", notifyExit(status: .provisional, alert: .enabled) == 0)
  caso("notifyExit: ainda não perguntado → 3", notifyExit(status: .notDetermined, alert: .enabled) == 3
       && notifyExit(status: .notDetermined, alert: .disabled) == 3)
  caso("notifyExit: recusado → 4", notifyExit(status: .denied, alert: .enabled) == 4 && notifyExit(status: .denied, alert: .disabled) == 4)
  caso("notifyExit: autorizado mas alertas desligados → 4", notifyExit(status: .authorized, alert: .disabled) == 4)
  caso("aviso de notificações: só texto, sem link", avisoNotificacoes.contains("desligadas") && !avisoNotificacoes.contains("://"))
  caso("aviso de notificações: 0 nenhum, 3 neutro, 4 desligadas", avisoNotificacoesTexto(0) == nil
       && avisoNotificacoesTexto(3) == avisoNotificacoesPendentes && avisoNotificacoesTexto(4) == avisoNotificacoes
       && !avisoNotificacoesPendentes.contains("desligadas"))
  caso("deveSolicitar: negado ou não perguntado, sem pedido neste build → pede",
       deveSolicitar(status: .denied, jaPediuNesteBuild: false) && deveSolicitar(status: .notDetermined, jaPediuNesteBuild: false))
  caso("deveSolicitar: já pediu neste build → não pede", !deveSolicitar(status: .denied, jaPediuNesteBuild: true)
       && !deveSolicitar(status: .notDetermined, jaPediuNesteBuild: true))
  caso("buildCarimbo: cdhash da própria assinatura (40 hex)", buildCarimbo().count == 40 && buildCarimbo().allSatisfy(\.isHexDigit))
  caso("deveSolicitar: autorizado → não pede", !deveSolicitar(status: .authorized, jaPediuNesteBuild: false))
  caso("disco livre: 39 GB", discoLivreTexto(39_000_000_000) == "Disco livre: 39 GB")
  caso("disco livre: ilegível → —", discoLivreTexto(nil) == "Disco livre: —")
  caso("statusText só memória (decisão 18)", statusText(memLoad: 62) == "62%")

  print(falhas == 0 ? "selftest: ok" : "selftest: \(falhas) falha(s)")
  return falhas == 0 ? 0 : 1
}

// MARK: - O app

enum Porta { case livre, folgaDeFora, ocupada }

/// Token do servidor (revisão de segurança): 32 bytes aleatórios em hex, novo a cada início do servidor, só na memória.
/// Vai pelo stdin para o servidor, num cookie para a janela e no cabeçalho das chamadas do menu; nunca para o disco.
func novoToken() -> String? {
  var b = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, b.count, &b) == errSecSuccess else { return nil }
  return b.map { String(format: "%02x", $0) }.joined()
}

/// GET /api/settings: conexão recusada → livre; 200 → um Folga de fora do app; resto (inclusive silêncio) → ocupada.
func olharPorta() async -> Porta {
  var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/settings")!)
  req.timeoutInterval = 2
  do {
    let (_, resp) = try await URLSession.shared.data(for: req)
    return (resp as? HTTPURLResponse)?.statusCode == 200 ? .folgaDeFora : .ocupada
  } catch let e as URLError where e.code == .cannotConnectToHost {
    return .livre
  } catch {
    return .ocupada
  }
}

@MainActor
final class Supervisor: NSObject, NSMenuDelegate {
  private var server: Process?
  private var crashes: [Date] = []
  private var upSince = Date()
  private var saindo = false
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let estado = NSMenuItem(title: "Iniciando…", action: nil, keyEquivalent: "")
  private let tentar = NSMenuItem(title: "O Folga parou — tentar de novo", action: #selector(tentarDeNovo), keyEquivalent: "")

  private let janela = Janela()
  /// Só existe quando foi este app que subiu o servidor: um Folga "de fora" ou outro programa na porta nunca o recebe.
  private var token: String? { didSet { janela.token = token } }
  private let liberar = NSMenuItem(title: "Liberar parados…", action: #selector(liberarParados), keyEquivalent: "")
  private let disco = NSMenuItem(title: "Disco livre: —", action: nil, keyEquivalent: "")
  private let acessoTotal = NSMenuItem(title: avisoAcessoTotal, action: nil, keyEquivalent: "")   // só texto, decisão 17
  private let notificacoes = NSMenuItem(title: avisoNotificacoes, action: nil, keyEquivalent: "")   // só texto
  private let avisos = NSMenuItem(title: "", action: #selector(abrirAvisos), keyEquivalent: "")
  var aoAbrirJanela: (() -> Void)?
  private var relogio: Timer?
  private let sessao = URLSession(configuration: .ephemeral)

  override init() {
    super.init()
    item.autosaveName = "local.folga.app.status"   // decisão 18: posição do ⌘-arrastar lembrada
    item.button?.image = NSImage(systemSymbolName: "memorychip", accessibilityDescription: "Folga")
    item.button?.image?.isTemplate = true
    item.button?.imagePosition = .imageLeading
    titulo("Folga")
    let menu = NSMenu()
    menu.autoenablesItems = false
    estado.isEnabled = false
    disco.isEnabled = false
    tentar.target = self
    tentar.isHidden = true
    let sair = NSMenuItem(title: "Sair", action: #selector(sairDoApp), keyEquivalent: "q")
    sair.target = self
    let abrir = NSMenuItem(title: "Abrir Folga", action: #selector(abrirJanela), keyEquivalent: "o")
    abrir.target = self
    liberar.target = self
    acessoTotal.isEnabled = false
    acessoTotal.isHidden = !hasFullDiskAccess()
    notificacoes.isEnabled = false
    notificacoes.isHidden = true
    avisos.target = self
    avisos.isHidden = true
    atualizarNotificacoes()
    menu.delegate = self
    for i in [avisos, disco, .separator(), abrir, liberar, .separator(), acessoTotal, notificacoes, estado, tentar, .separator(), sair] { menu.addItem(i) }
    item.menu = menu
    relogio = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in Task { @MainActor in await self.atualizarTexto() } }
    Task { await atualizarTexto() }
  }

  /// Item de notificações visível sempre que um `--notify` não entregaria (mesma regra, notifyExit ≠ 0).
  private func atualizarNotificacoes() {
    UNUserNotificationCenter.current().getNotificationSettings { st in
      let texto = avisoNotificacoesTexto(notifyExit(status: st.authorizationStatus, alert: st.alertSetting))
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.notificacoes.title = texto ?? ""
          self.notificacoes.isHidden = texto == nil
        }
      }
    }
  }

  @objc func abrirJanela() {
    janela.abrir()
    aoAbrirJanela?()
  }

  @objc private func abrirAvisos() {
    janela.abrir(vista: "avisos")
    aoAbrirJanela?()
  }

  /// Reavaliado a cada abertura do menu: desligada a permissão, o aviso some sozinho.
  func menuNeedsUpdate(_ menu: NSMenu) {
    acessoTotal.isHidden = !hasFullDiskAccess()
    atualizarNotificacoes()
    disco.title = discoLivreTexto((try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
      .volumeAvailableCapacityForImportantUsage)
  }

  @objc private func liberarParados() {
    guard liberar.isEnabled else { return }
    liberar.isEnabled = false   // sem segundo POST enquanto este roda
    Task {
      await liberarAgora()
      liberar.isEnabled = true
    }
  }

  private func pedir(_ metodo: String, _ caminho: String, token: String? = nil, corpo: Data? = nil) async -> (Int, [String: Any])? {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(caminho)")!)
    req.httpMethod = metodo
    req.timeoutInterval = metodo == "POST" ? 60 : 5   // liberar espera os apps fecharem
    if let corpo {
      req.httpBody = corpo
      req.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    if let token = token ?? self.token { req.setValue(token, forHTTPHeaderField: "x-folga-token") }
    guard let (data, resp) = try? await sessao.data(for: req), let http = resp as? HTTPURLResponse else { return nil }
    return (http.statusCode, (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
  }

  private func avisar(_ titulo: String, _ texto: String) {
    let a = NSAlert()
    a.messageText = titulo
    a.informativeText = texto
    NSApp.activate(ignoringOtherApps: true)
    a.runModal()
  }

  /// O mesmo caminho do botão da tela Memória: lista do servidor, confirmação, POST /api/release com o token.
  /// O releaser revalida tudo no clique (protegido → 409). O token é o da memória do app (nunca GET /api/token).
  private func liberarAgora() async {
    guard let (st, estado) = await pedir("GET", "/api/state"), st == 200 else {
      return avisar("O Folga não respondeu", "Tente de novo em alguns segundos.")
    }
    let apps = idleApps(estado)
    if apps.isEmpty { return avisar("Nada parado agora", "Nenhum app está parado neste momento.") }
    let total = apps.reduce(0) { $0 + $1.bytes }
    let a = NSAlert()
    a.messageText = "Liberar parados"
    a.informativeText = "Fechar do jeito normal (como Cmd+Q): \(apps.map(\.name).joined(separator: ", ")) — cerca de \(tamanho(total)). Cada app pode perguntar se você quer salvar."
    a.addButton(withTitle: "Cancelar")                        // 1º = Return
    a.addButton(withTitle: "Fechar").keyEquivalent = ""       // nenhuma tecla fecha apps
    // Esc também cancela (o botão Cancelar já tem o Return; um botão só tem uma tecla)
    let esc = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
      if e.keyCode == 53 { NSApp.stopModal(withCode: .alertFirstButtonReturn); return nil }
      return e
    }
    NSApp.activate(ignoringOtherApps: true)
    let resposta = a.runModal()
    if let esc { NSEvent.removeMonitor(esc) }
    guard confirmouFechar(resposta) else { return }

    guard let token else {
      return avisar("Não deu para liberar agora", "O Folga não respondeu. Tente de novo.")
    }
    // o alerta pode ficar aberto à vontade: o servidor só fecha o que ainda está parado no clique
    let corpo = try? JSONSerialization.data(withJSONObject: ["keys": apps.map(\.key), "onlyIdle": true])
    let r = await pedir("POST", "/api/release", token: token, corpo: corpo)
    let (titulo, texto) = resultadoLiberar(status: r?.0, corpo: r?.1 ?? [:])
    avisar(titulo, texto)
    await atualizarTexto()
  }

  private func titulo(_ t: String) {
    item.button?.attributedTitle = NSAttributedString(string: " " + t, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)])
  }

  /// memLoad do GET /api/state (o mesmo número da tela Início).
  private func atualizarTexto() async {
    var mem: Int?
    var soCriticos = false
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/state")!)
    req.timeoutInterval = 3
    req.setValue(token, forHTTPHeaderField: "x-folga-token")   // o servidor do app recusa /api/ sem token
    if let (data, resp) = try? await sessao.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      mem = (obj["memLoad"] as? NSNumber)?.intValue
      soCriticos = ((obj["settings"] as? [String: Any])?["warningsLevel"] as? String) == "criticos"
    }
    titulo(statusText(memLoad: mem))
    // servidor fora ou resposta ruim → item escondido (não "0 avisos")
    var rw = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/warnings")!)
    rw.timeoutInterval = 3
    rw.setValue(token, forHTTPHeaderField: "x-folga-token")
    var texto: String?
    if let (data, resp) = try? await sessao.data(for: rw), (resp as? HTTPURLResponse)?.statusCode == 200,
       let lista = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
      texto = avisosTexto(lista, soCriticos: soCriticos)
    }
    avisos.title = texto ?? ""
    avisos.isHidden = texto == nil
  }

  private func mostrar(_ texto: String) { estado.title = texto; logger.notice("\(texto, privacy: .public)") }   // o log do sistema guarda o que o menu mostrou

  func subir() {
    Task { @MainActor in
      let porta = await olharPorta()
      if porta != .livre { token = nil }   // servidor que não é nosso: o token deste app não vai para ele
      switch porta {
      case .folgaDeFora: mostrar("Folga rodando fora do app")   // não supervisiona, não mata; a janela usa esse servidor
      case .ocupada: mostrar("A porta \(port) está ocupada por outro programa")   // não mata nada
      case .livre: iniciar()
      }
    }
  }

  private func iniciar() {
    guard !saindo else { return }
    let cfg = (try? JSONSerialization.jsonObject(with: Data(contentsOf: resources.appendingPathComponent("folga.json")))) as? [String: String]
    guard let node = findNode(recorded: cfg?["node"] ?? "") else {
      mostrar("O Folga precisa do Node 24. Peça para reinstalar.")   // sem laço
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = ["--no-warnings", resources.appendingPathComponent("folga/src/server.ts").path]
    p.currentDirectoryURL = resources.appendingPathComponent("folga")
    p.environment = childEnv(from: ProcessInfo.processInfo.environment, appPath: Bundle.main.bundlePath, path: cfg?["path"] ?? "/usr/bin:/bin")
    guard let tk = novoToken() else { mostrar("Não deu para iniciar o servidor (sem número aleatório)"); return }
    let entrada = Pipe()
    p.standardInput = entrada   // o app nunca fecha: se o app cair, o pipe fecha e o servidor sai
    let dir = URL(fileURLWithPath: homeDir()).appendingPathComponent("Library/Application Support/Folga")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let log = openLog(at: dir.appendingPathComponent("server.log").path)
    p.standardOutput = log
    p.standardError = log
    p.terminationHandler = { _ in Task { @MainActor in self.caiu() } }
    do { try p.run() } catch { mostrar("Não deu para iniciar o servidor: \(error.localizedDescription)"); return }
    entrada.fileHandleForWriting.write(Data((tk + "\n").utf8))   // 1ª linha do stdin = token (server.ts)
    token = tk
    server = p
    upSince = Date()
    tentar.isHidden = true
    mostrar("Folga no ar")
  }

  private func caiu() {
    server = nil
    if saindo { return }
    let agora = Date()
    crashes = afterCrash(crashes, upSince: upSince, now: agora)
    guard let espera = nextDelay(crashes: crashes, now: agora) else {
      mostrar("O servidor caiu várias vezes")
      tentar.isHidden = false
      return
    }
    mostrar("O servidor caiu; volta em \(Int(espera)) s")
    DispatchQueue.main.asyncAfter(deadline: .now() + espera) { [self] in subir() }
  }

  @objc private func tentarDeNovo() {
    crashes = []
    tentar.isHidden = true
    subir()
  }

  /// Encerra só o Process que o app criou (nunca um pid procurado): SIGTERM, 3 s, SIGKILL nesse mesmo Process.
  func parar() {
    saindo = true
    guard let p = server, p.isRunning else { return }
    p.terminate()
    let limite = Date().addingTimeInterval(3)
    while p.isRunning && Date() < limite { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }   // isRunning logo antes: o pid ainda é do nosso filho
  }

  @objc private func sairDoApp() { parar(); NSApp.terminate(nil) }

}

/// Janela WebKit presa ao 127.0.0.1 do Folga. Sem ponte para o app: nenhum WKScriptMessageHandler, nenhum
/// addUserScript. O token vai num cookie HttpOnly do armazenamento só-memória da janela; com ele a página faz
/// GET /api/token na mesma origem, como no navegador (o servidor do app recusa /api/ sem token).
@MainActor
final class Janela: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
  private var window: NSWindow?
  private var web: WKWebView?
  private var aviso: NSTextField?
  private var tentativas = 0
  private var recargaAgendada = false
  private let inicio = URL(string: "http://127.0.0.1:\(port)/")!
  private var alvoAtual: URL?   // a recarga de "servidor subindo" volta para o mesmo alvo (#avisos incluído)
  /// Servidor novo = token novo: a janela aberta troca o cookie (o mesmo nome sobrescreve); sem token, apaga.
  var token: String? { didSet { if let web { gravarCookie(web) {} } } }

  private func gravarCookie(_ web: WKWebView, depois: @escaping () -> Void) {
    let loja = web.configuration.websiteDataStore.httpCookieStore
    let props: [HTTPCookiePropertyKey: Any] = [.domain: "127.0.0.1", .path: "/", .name: "folga_t", .value: token ?? "",
                                               HTTPCookiePropertyKey("HttpOnly"): "TRUE", .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict]
    guard let c = HTTPCookie(properties: props) else { return depois() }
    if token == nil { loja.delete(c) { depois() } } else { loja.setCookie(c) { depois() } }
  }

  /// `vista` ("avisos") vira o fragmento `#avisos`; sem janela, ela nasce já nela; com janela aberta, só troca o fragmento
  /// (a página escuta hashchange, sem recarregar nem passar por ponte).
  func abrir(vista: String? = nil) {
    // só [a-z]+: o nome vai para dentro de um JavaScript abaixo; qualquer outra coisa abre o início
    let v = vista.flatMap { $0.range(of: "^[a-z]+$", options: .regularExpression) != nil ? $0 : nil }
    let alvo = v.flatMap { URL(string: "http://127.0.0.1:\(port)/#\($0)") } ?? inicio
    if window == nil { criar(alvo) } else if let v {
      // passa por um hash neutro: a barra lateral troca de tela sem mexer no hash, e repetir o mesmo hash não dispara hashchange
      web?.evaluateJavaScript("location.hash = '_'; location.hash = '\(v)'")
    }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }

  private func criar(_ alvo: URL) {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .nonPersistent()   // nada de cache nem do token em disco
    cfg.userContentController = WKUserContentController()
    cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 760), configuration: cfg)
    if #available(macOS 13.3, *) { web.isInspectable = false }
    web.navigationDelegate = self
    web.uiDelegate = self
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
                     styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.title = "Folga"
    w.isReleasedWhenClosed = false
    w.delegate = self
    w.contentView = web
    let aviso = NSTextField(labelWithString: "Abrindo…")
    aviso.font = .systemFont(ofSize: 15)
    aviso.textColor = .secondaryLabelColor
    aviso.translatesAutoresizingMaskIntoConstraints = false
    web.addSubview(aviso)
    NSLayoutConstraint.activate([aviso.centerXAnchor.constraint(equalTo: web.centerXAnchor), aviso.centerYAnchor.constraint(equalTo: web.centerYAnchor)])
    w.center()
    self.window = w
    self.web = web
    self.aviso = aviso
    tentativas = 0
    alvoAtual = alvo
    gravarCookie(web) { web.load(URLRequest(url: alvo)) }
  }

  // Fechar destrói a janela e o WKWebView: o processo de conteúdo do WebKit sai (pegada em segundo plano, Task 9).
  func windowWillClose(_ n: Notification) {
    web?.stopLoading()
    web?.navigationDelegate = nil
    web?.uiDelegate = nil
    window?.contentView = nil
    window?.delegate = nil
    web = nil
    aviso = nil
    window = nil
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
    guard let url = action.request.url else { return .cancel }
    if allowedURL(url, port: port) { return .allow }
    // link https ativado vai para o navegador padrão; redirecionamento não abre nada. Limite conhecido: um
    // `.click()` de script num link https também conta como linkActivated (abre o navegador, nunca a janela)
    if url.scheme == "https", action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
    return .cancel
  }

  func webView(_ webView: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction,
               windowFeatures f: WKWindowFeatures) -> WKWebView? { nil }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    aviso?.isHidden = true
    tentativas = 0
  }

  // servidor ainda subindo (ou caiu): "Abrindo…" e nova tentativa a cada 1 s, por até 20 s; uma recarga agendada por vez
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    guard servidorFora(error), !recargaAgendada else { return }
    aviso?.stringValue = "Abrindo…"
    aviso?.isHidden = false
    tentativas += 1
    guard tentativas <= 20 else { aviso?.stringValue = "O Folga não respondeu. Feche e abra de novo."; return }
    recargaAgendada = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self else { return }
      self.recargaAgendada = false
      self.web?.load(URLRequest(url: self.alvoAtual ?? self.inicio))
    }
  }
}

/// Menu principal mínimo: sem ele, Cmd+C/Cmd+V/Cmd+W não funcionam na janela de um app de barra.
@MainActor
func menuPrincipal() -> NSMenu {
  let principal = NSMenu()
  let app = NSMenuItem()
  app.submenu = NSMenu()
  app.submenu?.addItem(NSMenuItem(title: "Fechar janela", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
  let editar = NSMenuItem()
  editar.submenu = NSMenu(title: "Editar")
  for (t, sel, k) in [("Desfazer", Selector(("undo:")), "z"), ("Recortar", #selector(NSText.cut(_:)), "x"),
                      ("Copiar", #selector(NSText.copy(_:)), "c"), ("Colar", #selector(NSText.paste(_:)), "v"),
                      ("Selecionar tudo", #selector(NSText.selectAll(_:)), "a")] {
    editar.submenu?.addItem(NSMenuItem(title: t, action: sel, keyEquivalent: k))
  }
  principal.addItem(app)
  principal.addItem(editar)
  return principal
}

/// Erro do UNUserNotificationCenter no stderr e no log (público): domínio, código e texto, nunca o conteúdo do aviso.
func relatar(_ etapa: String, _ erro: Error?) {
  guard let erro else { return }
  let e = erro as NSError
  let linha = "\(etapa): \(e.domain) \(e.code) \(e.localizedDescription)"
  logger.error("avisos \(linha, privacy: .public)")
  FileHandle.standardError.write(Data("folga avisos: \(linha)\n".utf8))
}

/// Carimbo do build instalado: o cdhash da própria assinatura (muda a cada build ad-hoc); sem ele, a versão.
func buildCarimbo() -> String {
  var code: SecCode?
  var staticCode: SecStaticCode?
  var info: CFDictionary?
  if SecCodeCopySelf([], &code) == errSecSuccess, let code, SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
     let staticCode, SecCodeCopySigningInformation(staticCode, [], &info) == errSecSuccess,
     let cd = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data {
    return cd.map { String(format: "%02x", $0) }.joined()
  }
  return "versao-\(version ?? "?")"
}

/// Uma linha datada em ~/Library/Application Support/Folga/notificacoes.log (mesmas travas do server.log) e no log público.
func anotarNotificacoes(_ linha: String) {
  logger.notice("avisos \(linha, privacy: .public)")
  FileHandle.standardError.write(Data("folga avisos: \(linha)\n".utf8))
  let dir = URL(fileURLWithPath: homeDir()).appendingPathComponent("Library/Application Support/Folga")
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let h = openLog(at: dir.appendingPathComponent("notificacoes.log").path)
  h.write(Data("\(ISO8601DateFormatter().string(from: Date())) \(linha)\n".utf8))
  if h !== FileHandle.nullDevice { try? h.close() }
}

/// `Folga --notify`: roda antes da instância única e nunca toca o supervisor nem abre janela. Texto só do ambiente.
/// Não pede autorização: quem pede é a instância principal (um processo de 10 s matava o pedido na tela).
/// 0 = postado · 3 = ainda não perguntado (ou sem resposta em 10 s) · 4 = recusado · 5 = erro ao postar.
func notificar() -> Never {
  let e = ProcessInfo.processInfo.environment
  let titulo = String((e["FOLGA_TOAST_TITLE"] ?? "Folga").prefix(200))
  let corpo = String((e["FOLGA_TOAST_BODY"] ?? "").prefix(500))
  let centro = UNUserNotificationCenter.current()
  DispatchQueue.global().asyncAfter(deadline: .now() + 10) { exit(3) }
  centro.getNotificationSettings { st in
    let codigo = notifyExit(status: st.authorizationStatus, alert: st.alertSetting)
    guard codigo == 0 else { exit(codigo) }
    let c = UNMutableNotificationContent()
    c.title = titulo
    c.body = corpo
    centro.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)) { erro in relatar("add", erro); exit(erro == nil ? 0 : 5) }
  }
  dispatchMain()
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  var supervisor: Supervisor?
  var sigterm: DispatchSourceSignal?
  let login: Bool
  private var pediu = false
  init(login: Bool) { self.login = login }

  /// Pede autorização uma vez por build instalado (cdhash), com o app de pé (o pedido fica na tela), se o estado
  /// não é autorizado — mesmo `.denied` (ver `deveSolicitar`). Cada passo vai para notificacoes.log, para quem
  /// instala ler o resultado sem `log show`.
  func pedirAutorizacao() {
    guard !pediu else { return }
    pediu = true
    let chave = "pedidoNotificacoesFeitoPara"
    let build = buildCarimbo()
    let centro = UNUserNotificationCenter.current()
    centro.getNotificationSettings { st in
      let antes = "status=\(st.authorizationStatus.rawValue) alert=\(st.alertSetting.rawValue)"
      guard deveSolicitar(status: st.authorizationStatus, jaPediuNesteBuild: UserDefaults.standard.string(forKey: chave) == build) else {
        anotarNotificacoes("build=\(build) \(antes) sem pedido (autorizado ou já pedido neste build)")
        return
      }
      UserDefaults.standard.set(build, forKey: chave)
      anotarNotificacoes("build=\(build) \(antes) pedindo")
      centro.requestAuthorization(options: [.alert, .sound]) { ok, erro in
        relatar("requestAuthorization", erro)
        let e = erro.map { $0 as NSError }
        anotarNotificacoes("build=\(build) granted=\(ok) erro=" + (e.map { "\($0.domain) \($0.code) \($0.localizedDescription)" } ?? "nenhum"))
      }
    }
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    // app de barra sem janela: sem isto o macOS pode encerrá-lo sozinho (Automatic Termination)
    ProcessInfo.processInfo.disableAutomaticTermination("Folga vigia o servidor")
    NSApp.mainMenu = menuPrincipal()
    let s = Supervisor()
    supervisor = s
    // segundo open: a outra instância avisa e sai; aqui só abre a janela (nunca lê object/userInfo)
    DistributedNotificationCenter.default().addObserver(forName: Notification.Name("\(bundleId).open"), object: nil, queue: .main) { _ in
      MainActor.assumeIsolated { s.abrirJanela() }
    }
    signal(SIGTERM, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    src.setEventHandler { MainActor.assumeIsolated { s.parar(); exit(0) } }
    src.resume()
    sigterm = src
    s.subir()
    UNUserNotificationCenter.current().delegate = self
    // no login o pedido não surge sozinho: espera o primeiro "Abrir Folga"
    if login { s.aoAbrirJanela = { [weak self] in self?.pedirAutorizacao() } } else { pedirAutorizacao() }
  }

  // clique no aviso → abre a janela (o aviso é postado pelo `Folga --notify`, outro processo do mesmo bundle)
  nonisolated func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                                          withCompletionHandler done: @escaping @Sendable () -> Void) {
    MainActor.assumeIsolated { supervisor?.abrirJanela() }
    done()
  }

  // `open` com o app já rodando não cria outro processo: o LaunchServices manda "reabrir" para este
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    supervisor?.abrirJanela()
    return false
  }

  func applicationWillTerminate(_ n: Notification) { supervisor?.parar() }
}

switch lancamento(Array(CommandLine.arguments.dropFirst())) {
case .versao: print("folga \(version ?? "?")")
case .selftest: exit(selftest())
case .notificar: notificar()
case .rodar(let login):
  let me = ProcessInfo.processInfo.processIdentifier
  // um `--notify` só nasce do servidor, que só roda com a instância principal viva: não há lançamento que ele possa barrar
  if NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).contains(where: { $0.processIdentifier != me }) {
    // no login (--login) já estar rodando é normal: sai quieto, sem mandar abrir janela
    if !login { DistributedNotificationCenter.default().postNotificationName(Notification.Name("\(bundleId).open"), object: nil, userInfo: nil, deliverImmediately: true) }
    exit(0)
  }
  MainActor.assumeIsolated {   // código de topo roda na thread principal
    let app = NSApplication.shared
    let delegate = AppDelegate(login: login)
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }
case .uso:
  FileHandle.standardError.write(Data("uso: Folga [--version | --selftest | --login | --notify]\n".utf8))
  exit(2)
}
