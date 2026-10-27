// Sonda do Mac: mesmo protocolo da probe.cs (uma linha JSON por leitura em stdout, comandos em stdin).
// Compilar: node scripts/build-probe.mjs  ->  probe/bin/probe-mac --interval N [--debug]
// Memória, pressão, swap, processos agrupados por bundle, janelas, primeiro plano, áudio e disco.
// close = Cmd+Q (terminate) em app do Dock; kill = forceTerminate/SIGKILL (só pelo caminho mayForceQuit).
import AppKit
import CoreServices
import CoreAudio
import Darwin
import IOKit

signal(SIGPIPE, SIG_IGN)

var interval = 2.0
var debug = false
do {
    let a = CommandLine.arguments
    var i = 1
    while i < a.count {
        if a[i] == "--debug" { debug = true }
        else if a[i] == "--interval", i + 1 < a.count { if let n = Int(a[i + 1]) { interval = Double(n) }; i += 1 }
        i += 1
    }
    if interval < 1 { interval = 1 }
}

func log(_ s: String) { if debug { fputs(s + "\n", stderr) } }

// Toda escrita acontece no main, então sem trava. stdout fechado = o Node morreu: não viramos órfã.
func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
          let s = String(data: d, encoding: .utf8) else { return }
    fputs(s + "\n", stdout)
    if fflush(stdout) == EOF { exit(0) }
}

// ---------- memória ----------
let pageSize: UInt64 = { var p: vm_size_t = 0; host_page_size(mach_host_self(), &p); return UInt64(p) }()
let totalPhys = ProcessInfo.processInfo.physicalMemory

func sysctlValue<T: BitwiseCopyable>(_ name: String, _ zero: T) -> T? {
    var v = zero
    var size = MemoryLayout<T>.size
    return sysctlbyname(name, &v, &size, nil, 0) == 0 ? v : nil
}

func memory() -> [String: Any] {
    var vm = vm_statistics64()
    var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &vm) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
    }
    var used: UInt64 = 0
    if kr == KERN_SUCCESS {
        let pages = UInt64(vm.internal_page_count) - UInt64(min(vm.purgeable_count, vm.internal_page_count))
            + UInt64(vm.wire_count) + UInt64(vm.compressor_page_count)
        used = min(pages * pageSize, totalPhys - 1)
    } else { fputs("host_statistics64 falhou: \(kr)\n", stderr) }
    let avail = totalPhys - used
    let level = sysctlValue("kern.memorystatus_vm_pressure_level", Int32(0)) ?? 1
    let pressure = level >= 4 ? "critical" : level >= 2 ? "warn" : "normal"
    let swap = sysctlValue("vm.swapusage", xsw_usage())?.xsu_used ?? 0
    return [
        "totalPhys": Int64(totalPhys), "availPhys": Int64(avail),
        "memLoad": Int((Double(used) / Double(totalPhys) * 100).rounded()),
        "memPressure": pressure, "swapUsed": Int64(swap),
    ]
}

// ---------- processos ----------
let timebase: (UInt64, UInt64) = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return (UInt64(t.numer), UInt64(t.denom)) }()

// ponytail: API privada, a mesma que o Monitor de Atividade usa; só para .xpc (WebKit do Safari). Sem ela o Safari aparece sem os processos de página.
typealias RespFn = @convention(c) (pid_t) -> pid_t
let respFn: RespFn? = dlsym(dlopen(nil, RTLD_NOW), "responsibility_get_pid_responsible_for_pid").map { unsafeBitCast($0, to: RespFn.self) }
func responsible(_ pid: pid_t) -> pid_t? { respFn.map { $0(pid) } }

func path(of pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : ""
}

// Dono por caminho do .app; vive entre leituras (apps não mudam de bundle id).
var ownerCache: [String: (name: String, description: String)] = [:]
func appOwner(_ path: String) -> (name: String, description: String)? {
    // o .app mais de fora: o primeiro ".app/" do caminho (helpers moram em .app dentro do .app)
    guard let r = path.range(of: ".app/") else { return nil }
    let app = String(path[..<r.lowerBound]) + ".app"
    if let o = ownerCache[app] { return o }
    let base = ((app as NSString).lastPathComponent as NSString).deletingPathExtension
    let name = Bundle(path: app)?.bundleIdentifier ?? base
    let desc = NSRunningApplication.runningApplications(withBundleIdentifier: name).first?.localizedName
        ?? ((FileManager.default.displayName(atPath: app) as NSString).deletingPathExtension)
    let o = (name: name, description: desc)
    ownerCache[app] = o
    return o
}

// ---------- janelas ----------
// windowCount só serve, no Mac, à proteção de navegador com várias janelas (R29, classify.ts multi_window);
// "tem janela" vem da bandeira .regular. Por pid: janelas na tela, camada 0, opacas e de pelo menos 50×50
// (o tamanho tira janela-fantasma). Não .optionAll: o AppKit guarda janela fechada escondida e ela entraria
// na conta. Preço: minimizada e de outro Espaço não contam — por isso o Chromium pergunta ao próprio app.
// Sem título: não pede Gravação de Tela.
func windowCounts() -> [pid_t: Int] {
    var c: [pid_t: Int] = [:]
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return c }
    for w in list {
        guard (w[kCGWindowLayer as String] as? Int) == 0, ((w[kCGWindowAlpha as String] as? Double) ?? 0) > 0,
              let pid = w[kCGWindowOwnerPID as String] as? Int,
              let b = w[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: b), r.width >= 50, r.height >= 50 else { continue }
        c[pid_t(pid), default: 0] += 1
    }
    return c
}

// Navegadores Chromium: o AppleScript do app conta minimizada e de outro Espaço, que é o que a R29 precisa.
// osascript em processo separado: nunca trava o laço principal; cache de 30 s por pid. Erro ou permissão negada
// (-1743) = fica a conta da tela, com um aviso só no stderr. A 1ª tentativa por bundle id dura até 60 s: é ela que
// mostra o pedido de permissão de Automação, e matar o osascript cedo some com o pedido antes de o usuário
// responder; enquanto ela espera (para qualquer instância do mesmo navegador), vale a conta da tela. As seguintes
// têm 2 s (+1 s até o SIGKILL). Tentativa que estourou o prazo = sem resposta do usuário: aquele bundle id não é
// mais perguntado enquanto a sonda viver, senão o pedido piscaria a cada 30 s.
let chromium: Set<String> = ["com.google.chrome", "com.microsoft.edgemac", "com.brave.browser",
                             "com.vivaldi.vivaldi", "com.operasoftware.opera", "org.chromium.chromium"]
enum ScriptState { case pending, settled, givenUp }   // ausente = nunca perguntado
var bundleState: [String: ScriptState] = [:]
var scriptCount: [pid_t: (t: Date, n: Int?)] = [:]
var scriptBusy: Set<pid_t> = []
var scriptKilled: Set<pid_t> = []   // osascript que nós matamos por prazo
var scriptWarned = false, scriptRunWarned = false, scriptGaveUpWarned = false
func chromiumWindows(_ app: NSRunningApplication) -> Int? {
    let pid = app.processIdentifier
    guard let id = app.bundleIdentifier, chromium.contains(id.lowercased()) else { return nil }
    let key = id.lowercased(), state = bundleState[key]
    scriptCount = scriptCount.filter { k, _ in NSRunningApplication(processIdentifier: k) != nil }
    if state == .givenUp { return nil }
    let cached = scriptCount[pid]
    if (cached.map { Date().timeIntervalSince($0.t) >= 30 } ?? true) && !scriptBusy.contains(pid) && state != .pending {
        let first = state == nil
        scriptBusy.insert(pid)
        if first { bundleState[key] = .pending }
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "tell application id \"\(id)\" to count windows"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { p in
            let n = p.terminationStatus == 0 ? Int(String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)) : nil
            let child = p.processIdentifier
            DispatchQueue.main.async {
                scriptBusy.remove(pid)
                if scriptKilled.remove(child) != nil {
                    bundleState[key] = .givenUp
                    if !scriptGaveUpWarned { scriptGaveUpWarned = true; fputs("janelas de \(id) pelo AppleScript: sem resposta no prazo; não pergunto mais, uso a conta da tela\n", stderr) }
                    return
                }
                bundleState[key] = .settled
                scriptCount[pid] = (Date(), n)
                if n == nil && !scriptWarned { scriptWarned = true; fputs("janelas de \(id) pelo AppleScript falhou (permissão de Automação?); usando a conta da tela\n", stderr) }
            }
        }
        do {
            try p.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + (first ? 60 : 2)) {
                guard p.isRunning else { return }
                let child = p.processIdentifier
                scriptKilled.insert(child)
                p.terminate()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if p.isRunning { kill(child, SIGKILL) } }
            }
        } catch {
            scriptBusy.remove(pid)
            bundleState[key] = .givenUp   // sem osascript não adianta tentar de novo
            if !scriptRunWarned { scriptRunWarned = true; fputs("osascript não abriu: \(error.localizedDescription); usando a conta da tela\n", stderr) }
        }
    }
    return cached?.n
}

// ---------- áudio ----------
func audioProp<T: BitwiseCopyable>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ v: inout T) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr
}

// pids tocando som agora (macOS 14.4+; antes disso, lista vazia)
func audioPids() -> [Int] {
    guard #available(macOS 14.4, *) else { return [] }
    let sys = AudioObjectID(kAudioObjectSystemObject)
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(sys, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(sys, &a, 0, nil, &size, &ids) == noErr else { return [] }
    var out: [Int] = []
    for id in ids {
        var pid: pid_t = 0, running: UInt32 = 0
        if audioProp(id, kAudioProcessPropertyPID, &pid), audioProp(id, kAudioProcessPropertyIsRunningOutput, &running), running != 0, pid > 0 {
            out.append(Int(pid))
        }
    }
    return out
}

// ---------- disco ----------
// ponytail: aproximação por vazão, não "% de tempo ativo": Δ(bytes lidos + escritos) de todos os drivers por
// segundo, contra um teto fixo de 2 GB/s. O tempo das operações ("Total Time") se sobrepõe e satura em 100.
// Nada age sobre este número; só o gráfico do Início.
let diskCeiling = 2_000_000_000.0
var lastDisk: (t: UInt64, bytes: UInt64)?
func diskActive() -> Any {
    var it: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOBlockStorageDriver"), &it) == KERN_SUCCESS else { return NSNull() }
    defer { IOObjectRelease(it) }
    var bytes: UInt64 = 0
    while case let svc = IOIteratorNext(it), svc != 0 {
        defer { IOObjectRelease(svc) }
        guard let st = IORegistryEntryCreateCFProperty(svc, "Statistics" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? [String: Any] else { continue }
        bytes &+= ((st["Bytes (Read)"] as? NSNumber)?.uint64Value ?? 0) &+ ((st["Bytes (Write)"] as? NSNumber)?.uint64Value ?? 0)
    }
    let now = DispatchTime.now().uptimeNanoseconds
    defer { lastDisk = (now, bytes) }
    guard let last = lastDisk, now > last.t, bytes >= last.bytes else { return NSNull() }   // 1ª leitura (ou disco que sumiu)
    let pct = Double(bytes - last.bytes) / (Double(now - last.t) / 1e9) / diskCeiling * 100
    return (min(100, pct) * 10).rounded() / 10
}

func process(_ pid: pid_t, _ wins: [pid_t: Int], _ regular: Set<pid_t>) -> [String: Any]? {
    // sysctl e não proc_pidinfo(PROC_PIDTBSDINFO): este falha nos processos de outro usuário (root, daemons)
    // e eles sumiriam da lista; o sysctl é o que o ps usa e enxerga todos.
    var kp = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &kp, &size, nil, 0) == 0, size > 0 else { return nil }   // sumiu no meio
    let p = path(of: pid)
    var name: String, desc = ""
    if let o = appOwner(p) { (name, desc) = o }
    else if p.contains(".xpc/"), let rp = responsible(pid), rp != pid, let o = appOwner(path(of: rp)) { (name, desc) = o }
    else if !p.isEmpty { name = (p as NSString).lastPathComponent }
    else {
        name = withUnsafeBytes(of: kp.kp_proc.p_comm) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        if name.isEmpty { name = "pid \(pid)" }
    }

    var ru = rusage_info_v4()
    let ok = withUnsafeMutablePointer(to: &ru) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
    } == 0
    let cpuMs = ok ? (ru.ri_user_time + ru.ri_system_time) * timebase.0 / timebase.1 / 1_000_000 : 0
    return [
        "pid": Int(pid), "ppid": Int(kp.kp_eproc.e_ppid), "name": name, "description": desc, "session": Int(kp.kp_eproc.e_ucred.cr_uid),
        "privateWorkingSet": ok ? Int64(ru.ri_phys_footprint) : 0, "cpuTimeMs": Int64(cpuMs),
        "hasVisibleWindow": regular.contains(pid), "windowCount": wins[pid] ?? 0, "accessible": ok,
    ]
}

func processes() -> [[String: Any]] {
    let n = proc_listallpids(nil, 0)
    guard n > 0 else { return [] }
    var pids = [pid_t](repeating: 0, count: Int(n) + 64)
    let got = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)))
    // Decisão 2026-10-20: no Mac "tem janela" = app do Dock (.regular), no processo principal do bundle;
    // app do Dock sem janela e parado pode sair com Cmd+Q. Barra de menus/agente segue "sem janela" (P03).
    var wins = windowCounts()
    var regular = Set<pid_t>()
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        regular.insert(app.processIdentifier)
        if let n = chromiumWindows(app) { wins[app.processIdentifier] = n }
    }
    return pids.prefix(max(0, got)).filter { $0 > 0 }.compactMap { process($0, wins, regular) }
}

func snapshot() {
    let t0 = DispatchTime.now().uptimeNanoseconds
    var s = memory()
    s["type"] = "snapshot"
    s["t"] = Int64(Date().timeIntervalSince1970 * 1000)
    s["foregroundPid"] = NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) } ?? NSNull()
    s["diskActive"] = diskActive()
    s["audioPids"] = audioPids()
    s["processes"] = processes()
    emit(s)
    var ri = rusage_info_v4()
    _ = withUnsafeMutablePointer(to: &ri) { $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0) } }
    log("leitura ms=\((DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000) privado=\(ri.ri_phys_footprint / 1_048_576)MB")
}

// ---------- comandos ----------
// inteiro ≥ 0 de verdade: JSON 1.5 e true também viram NSNumber
func isPid(_ v: Any) -> Bool {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), !CFNumberIsFloatType(n) else { return false }
    return n.int64Value >= 0 && n.int64Value <= Int64(Int32.max)
}

func handle(_ line: String) {
    guard let d = line.data(using: .utf8),
          let cmd = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          let id = cmd["id"] as? String else { return }   // sem id não há como responder
    let type = cmd["type"] as? String
    guard type == "close" || type == "kill", let raw = cmd["pids"] as? [Any], raw.allSatisfy(isPid) else {
        emit(["type": "reply", "id": id, "ok": false, "windowsClosed": 0]); return
    }
    let pids = raw.map { pid_t(($0 as! NSNumber).int32Value) }
    if type == "close" {
        // ADR 0003 no Mac = Cmd+Q: terminate() só em app do Dock (.regular). Helper e app de barra de menus nunca.
        // O app pode perguntar se salva e não sair; quem confere é o servidor, 8 s depois.
        // key = chave do grupo (bundle id minúsculo): pid reaproveitado por outro app nos segundos entre a leitura e o
        // clique não é fechado. Sem key (comando antigo, smoke) vale só o .regular.
        let key = cmd["key"] as? String
        var closed = 0
        for pid in pids {
            guard let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular else { continue }
            if let key = key, app.bundleIdentifier?.lowercased() != key { continue }
            if app.terminate() { closed += 1 }
        }
        emit(["type": "reply", "id": id, "ok": true, "windowsClosed": closed])
    } else {
        // só chega aqui pelo caminho mayForceQuit (P03)
        var all = true
        for pid in pids {
            if pid <= 0 { all = false; continue }   // kill(0) mataria o grupo inteiro, a sonda junto
            if let app = NSRunningApplication(processIdentifier: pid) { if !app.forceTerminate() { all = false } }
            else if kill(pid, SIGKILL) != 0 { all = false }
        }
        emit(["type": "reply", "id": id, "ok": all, "windowsClosed": 0])
    }
}

// ---------- modos de uma vez só (--meta, --trash, --size, --volume, --responsible, --disclaim) ----------
// JSON no stdin, JSON no stdout, sai com 0; entrada inválida → null e sai com 1. Não tocam o laço da sonda
// contínua (um comando longo de Lixeira no RunLoop.main atrasaria as leituras de memória).
func oneShotOut(_ obj: Any) -> Never {
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed]), let s = String(data: d, encoding: .utf8) {
        fputs(s + "\n", stdout); fflush(stdout); exit(0)
    }
    fputs("null\n", stdout); exit(1)
}
func oneShotInvalid() -> Never { fputs("null\n", stdout); fflush(stdout); exit(1) }
func readInput() -> Any? {
    let d = FileHandle.standardInput.readDataToEndOfFile()
    return d.isEmpty ? nil : try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
}
func canonical(_ path: String) -> String? {
    guard let r = realpath(path, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
}
let datalessFlag = UInt32(SF_DATALESS)
let ms = { (d: Date?) -> Any in d.map { Int64(($0.timeIntervalSince1970 * 1000).rounded()) } ?? NSNull() }

func oneShot(_ mode: String) -> Never {
    switch mode {
    case "--meta":
        // Spotlight: último uso e data em que chegou. lstat só para "sumiu" e "só na nuvem"; nunca abre o conteúdo.
        guard let paths = readInput() as? [String], paths.count <= 5000 else { oneShotInvalid() }
        oneShotOut(paths.map { path -> [String: Any] in
            var st = stat()
            guard lstat(path, &st) == 0 else { return ["lastUsed": NSNull(), "added": NSNull(), "dataless": false, "missing": true] }
            let item = MDItemCreate(nil, path as CFString)
            let attr = { (k: CFString) -> Date? in item.flatMap { MDItemCopyAttribute($0, k) as? Date } }
            return ["lastUsed": ms(attr(kMDItemLastUsedDate)), "added": ms(attr(kMDItemDateAdded)),
                    "dataless": st.st_flags & datalessFlag != 0, "missing": false]
        })

    case "--trash":
        // O Node já validou (R21); aqui revalida no último instante, porque entre a validação e agora uma pasta
        // do caminho pode ter virado link para fora (TOCTOU).
        guard let req = readInput() as? [String: Any], let rawRoots = req["roots"] as? [String], let paths = req["paths"] as? [String] else { oneShotInvalid() }
        let roots = rawRoots.compactMap(canonical)
        let appRoot = (req["appRoot"] as? String).flatMap(canonical)
        func refuse(_ erro: String) -> [String: Any] { ["ok": false, "inTrash": false, "trashed": NSNull(), "erro": erro] }
        oneShotOut(paths.map { path -> [String: Any] in
            // string idêntica: link em qualquer ponto do caminho (ou "..", "//") muda o resultado do realpath
            guard canonical(path) == path else { return refuse("caminho com link, relativo ou inexistente") }
            var st = stat()
            guard lstat(path, &st) == 0 else { return refuse("sumiu") }
            let kind = st.st_mode & S_IFMT
            let isApp = kind == S_IFDIR && path.hasSuffix(".app") && appRoot != nil
                && (path as NSString).deletingLastPathComponent == appRoot
            guard kind == S_IFREG || isApp else { return refuse("não é arquivo comum nem .app direto da pasta de apps") }
            guard st.st_flags & datalessFlag == 0 else { return refuse("só na nuvem (não baixado)") }
            guard roots.contains(where: { path.hasPrefix($0 + "/") }) else { return refuse("fora das pastas permitidas") }
            // ponytail: a janela entre esta checagem e o trashItem é de microssegundos, não fecha 100 %; fecharia com openat/O_NOFOLLOW por componente, que a API de Lixeira não aceita.
            var out: NSURL?
            do { try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: &out) }
            catch { return refuse("Lixeira recusou: \(error.localizedDescription)") }
            return ["ok": true, "inTrash": out != nil, "trashed": out?.path ?? NSNull()]
        })

    case "--size":
        // Soma alocada, sem seguir link. É por aqui que a Lixeira e o cache do Safari são medidos: quando o
        // Folga.app (plano 3) tiver o Acesso Total ao Disco, o macOS atribui a leitura a ele; a permissão nunca
        // vai para o processo do servidor.
        guard let root = readInput() as? String, !root.isEmpty else { oneShotInvalid() }
        guard let dir = opendir(root) else {
            if errno == EPERM || errno == EACCES { oneShotOut(["bytes": 0, "files": 0, "denied": true]) }
            oneShotInvalid()
        }
        closedir(dir)
        let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .isRegularFileKey]
        var bytes: Int64 = 0, files = 0
        let e = FileManager.default.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: keys, options: [], errorHandler: { _, _ in true })
        while let u = e?.nextObject() as? URL {
            guard let v = try? u.resourceValues(forKeys: Set(keys)) else { continue }
            bytes += Int64(v.totalFileAllocatedSize ?? 0)
            if v.isRegularFile == true { files += 1 }
        }
        oneShotOut(["bytes": bytes, "files": files, "denied": false])

    case "--volume":
        let args = CommandLine.arguments
        guard args.count >= 3, let v = try? URL(fileURLWithPath: args[2]).resourceValues(forKeys:
            [.volumeLocalizedNameKey, .volumeTotalCapacityKey, .volumeAvailableCapacityKey, .volumeAvailableCapacityForImportantUsageKey]),
              let total = v.volumeTotalCapacity else { oneShotInvalid() }
        oneShotOut(["name": v.volumeLocalizedName ?? "", "total": Int64(total), "available": Int64(v.volumeAvailableCapacity ?? 0),
                    "important": v.volumeAvailableCapacityForImportantUsage ?? 0])

    case "--responsible":
        // Quem o macOS (TCC) cobra pelas leituras deste processo: dentro do app, o próprio Folga.app.
        let me = getpid()
        let r = responsible(me) ?? 0
        oneShotOut(["pid": Int(me), "responsible": Int(r), "path": r > 0 ? path(of: r) : ""])

    case "--disclaim":
        // 125 = disclaim indisponível (nada executado; distinto do 126/127 que um CLI pode devolver).
        // Executa `cmd args…` responsável por si mesmo: o assistente não herda o Acesso Total ao Disco do Folga.app.
        // Só TIRA a herança (o programa passa a responder pelas próprias permissões); nunca dá nada a ninguém.
        // ponytail: API privada (a mesma do Chromium para os processos filhos); sem o símbolo, sai 125 sem
        // executar nada (melhor o assistente não rodar no app do que rodar com o acesso dele). Some num macOS
        // futuro → o assistente para dentro do app até trocar por outra forma (ex.: lançar pelo launchd).
        let rest = Array(CommandLine.arguments.dropFirst(2))
        guard let cmd = rest.first else { fputs("uso: probe-mac --disclaim <cmd> [args…]\n", stderr); exit(125) }
        typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        guard let sym = dlsym(dlopen(nil, RTLD_NOW), "responsibility_spawnattrs_setdisclaim") else {
            fputs("probe-mac: responsibility_spawnattrs_setdisclaim ausente; nada executado\n", stderr); exit(125)
        }
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        // SETEXEC: troca a imagem deste processo (mesmo pid, mesmo stdio): o kill do Node acerta no programa final
        guard unsafeBitCast(sym, to: SetDisclaim.self)(&attr, 1) == 0,
              posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC)) == 0 else {
            fputs("probe-mac: não deu para preparar o disclaim; nada executado\n", stderr); exit(125)
        }
        let argv = rest.map { strdup($0) } + [nil]
        let rc = posix_spawnp(nil, cmd, nil, &attr, argv, environ)
        fputs("probe-mac: não deu para executar \(cmd): \(String(cString: strerror(rc)))\n", stderr)
        exit(127)

    default:
        oneShotInvalid()
    }
}

if let mode = CommandLine.arguments.dropFirst().first, mode.hasPrefix("--") && mode != "--interval" && mode != "--debug" { oneShot(mode) }

Thread {
    while let line = readLine() { DispatchQueue.main.async { handle(line) } }
    DispatchQueue.main.async { exit(0) }   // stdin fechou: o Node morreu ou nos dispensou
}.start()

snapshot()
Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in snapshot() }
RunLoop.main.run()
