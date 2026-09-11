import QtQuick
import Quickshell
import Quickshell.Io
// The runner stages this fixture and protocol.js inside one Quickshell config root.
import "protocol.js" as Protocol

Scope {
  id: root
  property string pending: "😀".repeat(1024)
  property var lines: Protocol.lineStream(32, 64, 1)
  property bool received: false

  Process {
    id: probe
    command: ["/usr/bin/node", Qt.resolvedUrl("stdio-probe.js").toString().replace("file://", "")]
    clearEnvironment: true
    environment: ({ "LANG": "C.UTF-8" })
    stdinEnabled: true
    running: true
    onStarted: {
      try { probe.write(root.pending) }
      finally { probe.stdinEnabled = false; root.pending = "" }
    }
    stdout: SplitParser {
      splitMarker: ""
      onRead: data => {
        if (!root.lines.push(data, line => { root.received = JSON.parse(line).ok === true }))
          console.log("FAIL: stream overflow")
      }
    }
    onExited: (code, status) => {
      console.log(code === 0 && status === 0 && root.received && root.lines.finish()
        && root.pending === "" && !probe.stdinEnabled ? "STDIN_SMOKE_PASS" : "FAIL: stdin transport")
      Qt.quit()
    }
  }
  Timer {
    interval: 5000
    running: true
    onTriggered: { console.log("FAIL: timeout"); Qt.quit() }
  }
}
