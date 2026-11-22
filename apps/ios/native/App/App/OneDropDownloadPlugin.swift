import Capacitor
import UIKit
import UniformTypeIdentifiers

@objc(OneDropDownloadPlugin)
final class OneDropDownloadPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDownloadDelegate, UIDocumentInteractionControllerDelegate {
    let identifier = "OneDropDownloadPlugin"
    let jsName = "OneDropDownload"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "previousDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportLocal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "export", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showInFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyImage", returnType: CAPPluginReturnPromise)
    ]

    private struct DownloadContext {
        let driveItemId: String
        let fileName: String
        let call: CAPPluginCall
    }

    private let downloadLock = NSRecursiveLock()
    private var cancelledTasks = Set<Int>()
    private var contexts: [Int: DownloadContext] = [:]
    private var tasksByDriveItemId: [String: URLSessionDownloadTask] = [:]
    private var documentController: UIDocumentInteractionController?
    private lazy var session = URLSession(
        configuration: .default,
        delegate: self,
        delegateQueue: nil
    )

    @objc func previousDownloads(_ call: CAPPluginCall) {
        downloadLock.lock()
        defer { downloadLock.unlock() }
        var files: [[String: String]] = []
        let prefix = "onedrop.download."
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
            let id = String(key.dropFirst(prefix.count))
            if id.range(of: "^[0-9a-f]{64}:", options: .regularExpression) != nil { continue }
            if let url = storedURL(for: id), FileManager.default.fileExists(atPath: url.path) {
                files.append(["id": id, "name": url.lastPathComponent])
            }
        }
        call.resolve(["files": files])
    }

    @objc func download(_ call: CAPPluginCall) {
        downloadLock.lock()
        defer { downloadLock.unlock() }
        guard let value = call.getString("url"), let url = URL(string: value),
              let driveItemId = call.getString("driveItemId"), !driveItemId.isEmpty,
              let fileName = call.getString("fileName"), !fileName.isEmpty else {
            call.reject("The download request is incomplete.")
            return
        }
        guard tasksByDriveItemId[driveItemId] == nil else {
            call.reject("This file is already downloading.")
            return
        }
        let task = session.downloadTask(with: url)
        contexts[task.taskIdentifier] = DownloadContext(
            driveItemId: driveItemId,
            fileName: sanitize(fileName),
            call: call
        )
        tasksByDriveItemId[driveItemId] = task
        task.resume()
    }

    @objc func removeAccount(_ call: CAPPluginCall) {
        guard let scope = call.getString("scope"), scope.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { call.reject("Invalid account scope."); return }
        downloadLock.lock()
        defer { downloadLock.unlock() }
        let prefix = scope + ":"
        for (id, task) in tasksByDriveItemId where id.hasPrefix(prefix) { cancelledTasks.insert(task.taskIdentifier); task.cancel() }
        do {
            for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("onedrop.download." + prefix) {
                let id = String(key.dropFirst("onedrop.download.".count))
                if let url = storedURL(for: id), FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                UserDefaults.standard.removeObject(forKey: key)
            }
            call.resolve()
        } catch { call.reject("Account downloads could not be removed.") }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        downloadLock.lock()
        defer { downloadLock.unlock() }
        guard let driveItemId = call.getString("driveItemId") else {
            call.reject("The download identifier is missing.")
            return
        }
        tasksByDriveItemId[driveItemId]?.cancel()
        call.resolve()
    }

    @objc func status(_ call: CAPPluginCall) {
        downloadLock.lock()
        defer { downloadLock.unlock() }
        guard let driveItemId = call.getString("driveItemId") else {
            call.reject("The download identifier is missing.")
            return
        }
        let url = storedURL(for: driveItemId)
        var result: [String: Any] = [
            "exists": url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false,
            "downloading": tasksByDriveItemId[driveItemId] != nil
        ]
        if let fileName = url?.lastPathComponent {
            result["fileName"] = fileName
        }
        call.resolve(result)
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let driveItemId = call.getString("driveItemId"),
              let url = storedURL(for: driveItemId),
              FileManager.default.fileExists(atPath: url.path) else {
            call.reject("The local file no longer exists. Please download it again.")
            return
        }
        DispatchQueue.main.async {
            let controller = UIDocumentInteractionController(url: url)
            controller.delegate = self
            self.documentController = controller
            guard controller.presentPreview(animated: true) else {
                call.reject("iOS could not open this file.")
                return
            }
            call.resolve(["fileName": url.lastPathComponent])
        }
    }

    @objc func exportLocal(_ call: CAPPluginCall) {
        guard let name = call.getString("fileName"), let base64 = call.getString("base64"),
              base64.count <= 710000, let data = Data(base64Encoded: base64),
              let identifier = call.getString("exportId"), UUID(uuidString: identifier) != nil,
              let offset = call.getInt("offset"), offset >= 0 else {
            call.reject("The local file is unavailable."); return
        }
        let filename = (name as NSString).lastPathComponent
        guard !filename.isEmpty, filename != ".", filename != "..", filename != "/" else {
            call.reject("The local filename is invalid."); return
        }
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("onedrop-exports").appendingPathComponent(identifier)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(filename)
            if offset == 0 { try Data().write(to: url) }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            guard try handle.seekToEnd() == UInt64(offset) else {
                call.reject("The local export is incomplete."); return
            }
            try handle.write(contentsOf: data)
            if call.getBool("complete") != true {
                call.resolve(["fileName": filename]); return
            }
            DispatchQueue.main.async {
                let controller = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
                self.bridge?.viewController?.present(controller, animated: true)
                call.resolve(["fileName": filename])
            }
        } catch { call.reject("The local file could not be exported.") }
    }

    @objc func export(_ call: CAPPluginCall) {
        guard let driveItemId = call.getString("driveItemId"),
              let url = storedURL(for: driveItemId),
              FileManager.default.fileExists(atPath: url.path) else {
            call.reject("The local file no longer exists. Please download it again.")
            return
        }
        DispatchQueue.main.async {
            let controller = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            self.bridge?.viewController?.present(controller, animated: true)
            call.resolve(["fileName": url.lastPathComponent])
        }
    }

    @objc func showInFolder(_ call: CAPPluginCall) {
        guard let driveItemId = call.getString("driveItemId"),
              let url = storedURL(for: driveItemId),
              FileManager.default.fileExists(atPath: url.path) else {
            call.reject("The local file no longer exists. Please download it again.")
            return
        }
        DispatchQueue.main.async {
            let controller = UIDocumentPickerViewController(
                forOpeningContentTypes: [UTType.item],
                asCopy: false
            )
            controller.directoryURL = url.deletingLastPathComponent()
            self.bridge?.viewController?.present(controller, animated: true)
            call.resolve(["fileName": url.lastPathComponent])
        }
    }

    @objc func openExternal(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let url = URL(string: value) else {
            call.reject("The external link is invalid.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() }
                else { call.reject("iOS could not open this link.") }
            }
        }
    }

    @objc func copyText(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else {
            call.reject("The text is unavailable.")
            return
        }
        DispatchQueue.main.async {
            UIPasteboard.general.string = text
            call.resolve()
        }
    }

    @objc func copyImage(_ call: CAPPluginCall) {
        guard let dataURL = call.getString("dataUrl"),
              let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              let image = UIImage(data: data) else {
            call.reject("The image is unavailable.")
            return
        }
        DispatchQueue.main.async {
            UIPasteboard.general.image = image
            call.resolve()
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        downloadLock.lock()
        defer { downloadLock.unlock() }
        guard let context = contexts[downloadTask.taskIdentifier] else { return }
        notifyListeners("progress", data: [
            "driveItemId": context.driveItemId,
            "receivedBytes": totalBytesWritten,
            "totalBytes": max(totalBytesExpectedToWrite, 0)
        ])
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        downloadLock.lock()
        defer { downloadLock.unlock() }
        guard let context = contexts[downloadTask.taskIdentifier] else { return }
        if cancelledTasks.remove(downloadTask.taskIdentifier) != nil { finish(downloadTask, context: context); context.call.reject("Download cancelled."); return }
        do {
            let directory = try downloadDirectory()
            let destination = uniqueDestination(in: directory, fileName: context.fileName)
            try FileManager.default.moveItem(at: location, to: destination)
            store(destination, for: context.driveItemId)
            finish(downloadTask, context: context)
            context.call.resolve(["fileName": destination.lastPathComponent])
        } catch {
            finish(downloadTask, context: context)
            context.call.reject("The downloaded file could not be saved: \(error.localizedDescription)")
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        downloadLock.lock()
        defer { downloadLock.unlock() }
        guard let error, let context = contexts[task.taskIdentifier] else { return }
        finish(task, context: context)
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            context.call.reject("Download cancelled.")
        } else {
            context.call.reject("Download failed: \(error.localizedDescription)")
        }
    }

    func documentInteractionControllerViewControllerForPreview(
        _ controller: UIDocumentInteractionController
    ) -> UIViewController {
        bridge?.viewController ?? UIViewController()
    }

    private func finish(_ task: URLSessionTask, context: DownloadContext) {
        downloadLock.lock()
        defer { downloadLock.unlock() }
        cancelledTasks.remove(task.taskIdentifier)
        contexts.removeValue(forKey: task.taskIdentifier)
        tasksByDriveItemId.removeValue(forKey: context.driveItemId)
    }

    private func downloadDirectory() throws -> URL {
        return try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
    }

    private func uniqueDestination(in directory: URL, fileName: String) -> URL {
        let base = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        var candidate = directory.appendingPathComponent(fileName)
        var suffix = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            let next = ext.isEmpty ? "\(base) (\(suffix))" : "\(base) (\(suffix)).\(ext)"
            candidate = directory.appendingPathComponent(next)
            suffix += 1
        }
        return candidate
    }

    private func sanitize(_ fileName: String) -> String {
        let value = (fileName as NSString).lastPathComponent
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return value.isEmpty ? "download" : value
    }

    private func store(_ url: URL, for driveItemId: String) {
        UserDefaults.standard.set(url.path, forKey: storageKey(driveItemId))
    }

    private func storedURL(for driveItemId: String) -> URL? {
        guard let path = UserDefaults.standard.string(forKey: storageKey(driveItemId)) else {
            return nil
        }
        return URL(fileURLWithPath: path)
    }

    private func storageKey(_ driveItemId: String) -> String {
        "onedrop.download.\(driveItemId)"
    }
}
