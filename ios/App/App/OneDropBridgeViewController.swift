import Capacitor

final class OneDropBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        guard let bridge else {
            CAPLog.print("⚡️  OneDropAuth registration failed: bridge is unavailable")
            return
        }

        // Capacitor 8 enables automatic package registration by default. In that
        // mode registerPluginType(_:) intentionally returns without doing anything,
        // so an app-local plugin must be registered as an instance instead.
        bridge.registerPluginInstance(OneDropAuthPlugin())
        bridge.registerPluginInstance(OneDropDownloadPlugin())

        if bridge.plugin(withName: "OneDropAuth") == nil {
            CAPLog.print("⚡️  OneDropAuth registration failed: plugin is absent from the bridge")
        } else {
            CAPLog.print("⚡️  OneDropAuth registered")
        }
        if bridge.plugin(withName: "OneDropDownload") == nil {
            CAPLog.print("⚡️  OneDropDownload registration failed")
        } else {
            CAPLog.print("⚡️  OneDropDownload registered")
        }
    }
}
