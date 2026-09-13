import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "protocol.js" as Protocol

// NoMorePass overlay: requests a ticket from api.nomorepass.com, shows the
// QR code rendered by qrencode and, once the mobile app approves the send,
// copies the received credential to the clipboard with wl-copy.
//
// Summon:
//   omarchy-shell shell summon io.github.yoprogramo.omanomorepass '{"site":"example.com"}'
// Optional payload keys: site (info text baked into the QR), timeout (seconds).
Item {
  id: root

  readonly property string helperPath: Qt.resolvedUrl("nmp-helper.js").toString().replace("file://", "")

  property bool opened: false
  property string site: "omarchy"
  property int timeoutSecs: 90
  // idle | requesting | waiting | copying | success | error
  property string state: "idle"
  property string statusMessage: ""
  property string successUser: ""
  property string qrImageSource: ""
  property string pendingSecret: ""
  property var eventStream: null
  property var diagnosticStream: null

  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  property color scrim: Color.menu.scrim
  property color selectedText: Color.menu.selectedText
  readonly property int cornerRadius: Style.cornerRadius
  property string fontFamily: Style.font.menuFamily
  property int contentMargin: Style.spacing.panelPadding

  property var spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  property int spinnerIndex: 0
  readonly property bool busy: state === "requesting" || state === "waiting"

  // console.log from user plugins does not reach journald; log.js appends to a
  // private, owner-only state log instead. Messages are redacted before they
  // get here: never the password. The logger fails closed if the state path is
  // a symlink or is not owned by the user, so it cannot be redirected.
  readonly property string logJs: Qt.resolvedUrl("log.js").toString().replace("file://", "")
  function nlog(msg) {
    Quickshell.execDetached({
      command: ["/usr/bin/node", root.logJs, String(msg)],
      clearEnvironment: true,
      environment: { "HOME": Quickshell.env("HOME"), "LANG": "C.UTF-8" }
    })
  }

  function open(payloadJson) {
    root.close()
    var payload = {}
    try {
      if (!Protocol.boundedString(payloadJson || "{}", 2048, true)) throw new Error("Invalid payload")
      payload = JSON.parse(payloadJson || "{}")
      if (!Protocol.schema(payload, [], ["site", "timeout"])) throw new Error("Invalid payload")
      if (payload.site !== undefined && (!Protocol.boundedString(payload.site, Protocol.limits.site, true)
          || /[\u0000-\u001f\u007f]/.test(payload.site))) throw new Error("Invalid site")
      if (payload.timeout !== undefined && (typeof payload.timeout !== "number"
          || !isFinite(payload.timeout) || payload.timeout < 1 || payload.timeout > 900)) throw new Error("Invalid timeout")
    } catch (e) {
      root.opened = true
      root.fail("Invalid input: site is limited to 256 UTF-8 bytes; timeout to 1–900 seconds.")
      return
    }
    // Default site carries a timestamp: the phone app shows the site when
    // confirming the send, so a mismatch against the card label instantly
    // reveals a scan of a stale QR.
    root.site = typeof payload.site === "string" && payload.site ? payload.site : ("omarchy-" + Qt.formatDateTime(new Date(), "HHmmss"))
    root.timeoutSecs = typeof payload.timeout === "number" && payload.timeout > 0 ? payload.timeout : 90
    nlog("open")
    root.state = "requesting"
    root.statusMessage = "Requesting ticket from nomorepass…"
    root.successUser = ""
    root.qrImageSource = ""
    root.opened = true
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    Qt.callLater(root.startHelper)
  }

  function close() {
    root.opened = false
    root.state = "idle"
    helperProc.running = false
    copyProc.running = false
    copyProc.stdinEnabled = false
    root.pendingSecret = ""
    root.successUser = ""
    if (root.eventStream) root.eventStream.fail()
    if (root.diagnosticStream) root.diagnosticStream.fail()
    autoCloseTimer.stop()
    copyDeadline.stop()
    root.qrImageSource = ""
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open("{}")
  }

  function fail(message) {
    root.state = "error"
    root.statusMessage = message
    helperProc.running = false
    copyProc.running = false
    copyProc.stdinEnabled = false
    root.pendingSecret = ""
    root.qrImageSource = ""
    if (root.eventStream) root.eventStream.fail()
    if (root.diagnosticStream) root.diagnosticStream.fail()
    copyDeadline.stop()
  }

  // Fixed system binaries and an allowlisted environment: no PATH or runtime hooks.
  function startHelper() {
    if (!root.opened || root.state !== "requesting") return
    helperProc.running = false
    root.eventStream = Protocol.lineStream(Protocol.limits.line, Protocol.limits.output, Protocol.limits.events)
    root.diagnosticStream = Protocol.lineStream(Protocol.limits.stderrLine, Protocol.limits.stderrOutput, 310)
    helperProc.command = [
      "/usr/bin/node",
      root.helperPath, "--site", root.site, "--timeout", String(root.timeoutSecs)
    ]
    helperProc.running = true
  }

  function handleEvent(ev) {
    if (!root.opened) return
    if (root.state === "copying") { root.fail("Unexpected event after credentials."); return }
    if (!root.busy) return
    if (!Protocol.validEvent(ev)) { root.fail("Invalid helper event."); return }
    nlog("event=" + ev.event)
    switch (ev.event) {
    case "status":
      break
    case "qr":
      if (root.state !== "requesting") { root.fail("Unexpected QR event."); return }
      root.statusMessage = "Waiting for scan…"
      root.qrImageSource = "data:image/png;base64," + ev.image
      root.state = "waiting"
      break
    case "credentials":
      if (root.state !== "waiting") { root.fail("Unexpected credential event."); return }
      root.copyCredential(ev)
      break
    case "denied":
      root.fail("The send was rejected from the phone.")
      break
    case "expired":
      root.fail("The ticket expired. Please try again.")
      break
    case "timeout":
      root.fail("Timed out waiting for a scan.")
      break
    case "error":
      root.fail(ev.message)
      break
    }
  }

  function copyCredential(ev) {
    if (!Protocol.boundedString(ev.password, Protocol.limits.password, false)
        || !Protocol.boundedString(ev.user, Protocol.limits.user, false) || copyProc.running) {
      ev.password = ""
      root.fail("Invalid credential or clipboard operation already running.")
      return
    }
    var secret = ev.password || ev.user
    ev.password = ""
    if (!secret) {
      root.fail("The received credential is empty.")
      return
    }
    root.successUser = ev.user || ""
    root.pendingSecret = secret
    secret = ""
    root.qrImageSource = ""
    root.state = "copying"
    root.statusMessage = "Copying to clipboard…"
    copyProc.stdinEnabled = true
    copyDeadline.restart()
    copyProc.running = true
  }

  // Tests the whole credential→clipboard path without a phone:
  //   omarchy-shell shell call io.github.yoprogramo.omanomorepass testCopy ""
  // then: wl-paste
  function testCopy(arg) {
    copyCredential({ user: "test-user", password: "nmp-test-" + Date.now() })
  }

  IpcHandler {
    target: "io.github.yoprogramo.omanomorepass"

    function open(): void { root.open("{}") }
    function openSite(site: string): void { root.open(JSON.stringify({ site: site })) }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function testCopy(arg: string): void { root.testCopy(arg) }
  }

  Timer {
    id: copyDeadline
    interval: 5000
    onTriggered: root.fail("Clipboard operation timed out.")
  }

  Timer {
    id: spinnerTimer
    interval: 80
    running: root.busy || root.state === "copying"
    repeat: true
    onTriggered: root.spinnerIndex = (root.spinnerIndex + 1) % root.spinnerFrames.length
  }

  Timer {
    id: autoCloseTimer
    interval: 4000
    onTriggered: root.close()
  }

  Process {
    id: helperProc
    clearEnvironment: true
    environment: ({ "LANG": "C.UTF-8", "NMP_APIKEY": null })
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(data) {
        if (!root.opened || (!root.busy && root.state !== "copying")) return
        if (!root.eventStream.push(data, function(line) {
          try { root.handleEvent(JSON.parse(line)) } catch (e) { root.fail("Invalid helper output.") }
        }) && (root.busy || root.state === "copying")) {
          root.fail("Helper output exceeded its limit.")
        }
      }
    }
    stderr: SplitParser {
      splitMarker: ""
      onRead: function(data) {
        if (!root.opened || (!root.busy && root.state !== "copying")) return
        // Never forward raw subprocess diagnostics; they may contain secrets.
        if (!root.diagnosticStream.push(data, function(line) {})) root.fail("Helper diagnostics exceeded their limit.")
      }
    }
    onRunningChanged: {
      if (!running && root.busy) root.fail("NoMorePass helper stopped; /usr/bin/node and /usr/bin/qrencode are required.")
    }
    onExited: function(exitCode, exitStatus) {
      nlog("helper exited code=" + exitCode)
      if (root.state === "copying" && (exitCode !== 0 || exitStatus !== 0 || !root.eventStream.finish())) {
        root.fail("Incomplete helper output.")
        return
      }
      if (root.busy) root.fail("NoMorePass helper ended before completing the transfer.")
    }
  }

  Process {
    id: copyProc
    command: ["/usr/bin/wl-copy"]
    clearEnvironment: true
    environment: ({ "WAYLAND_DISPLAY": null, "XDG_RUNTIME_DIR": null, "LANG": "C.UTF-8" })
    onStarted: {
      try { copyProc.write(root.pendingSecret) }
      finally {
        copyProc.stdinEnabled = false
        root.pendingSecret = ""
      }
    }
    onRunningChanged: {
      if (!running) {
        root.pendingSecret = ""
        copyProc.stdinEnabled = false
        // Failed starts do not emit exited. Defer to let a normal exit report first.
        Qt.callLater(function() { if (root.state === "copying") root.fail("Could not start /usr/bin/wl-copy.") })
      }
    }
    onExited: function(exitCode, exitStatus) {
      root.pendingSecret = ""
      copyDeadline.stop()
      nlog("wl-copy exited code=" + exitCode)
      if (root.state !== "copying") return
      if (exitCode !== 0 || exitStatus !== 0) { root.fail("Could not copy the credential."); return }
      root.state = "success"
      root.statusMessage = "Copied to clipboard"
      autoCloseTimer.restart()
    }
  }

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omanomorepass"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.close()
    }

    BorderSurface {
      id: card
      width: Math.min(Style.space(420), panel.width - Style.gapsOut * 2)
      height: Math.min(Style.space(520), panel.height - Style.gapsOut * 2)
      radius: root.cornerRadius
      anchors.centerIn: parent
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true

        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Escape) {
            root.close()
            event.accepted = true
          }
        }
      }

      Column {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.leftMargin: card.contentLeftInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        spacing: Style.space(14)

        Item {
          width: parent.width
          height: Style.space(30)

          Text {
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "NoMorePass"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
          }

          Text {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.site
            color: root.foreground
            opacity: 0.6
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        Item {
          width: parent.width
          height: parent.height - parent.spacing - Style.space(30) - Style.space(24)

          // QR
          Rectangle {
            visible: root.state === "waiting"
            anchors.centerIn: parent
            width: Style.space(280)
            height: Style.space(280)
            radius: root.cornerRadius
            color: "white"

            Image {
              anchors.fill: parent
              anchors.margins: Style.space(10)
              source: root.qrImageSource
              cache: false
              fillMode: Image.PreserveAspectFit
              smooth: true
              asynchronous: true
            }
          }

          // Requesting state
          Column {
            anchors.centerIn: parent
            spacing: Style.space(12)
            visible: root.state === "requesting" || root.state === "copying"

            Text {
              width: parent.width
              text: root.spinnerFrames[root.spinnerIndex]
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.statusMessage
              color: root.foreground
              opacity: 0.75
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WrapAnywhere
            }
          }

          // Waiting state: scan hint under the QR
          Text {
            visible: root.state === "waiting"
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            text: "Scan with the NoMorePass app"
            color: root.foreground
            opacity: 0.7
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          // Success
          Column {
            anchors.centerIn: parent
            spacing: Style.space(8)
            visible: root.state === "success"

            Text {
              width: parent.width
              text: "✓"
              color: root.selectedText
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.statusMessage
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              visible: root.successUser !== ""
              width: parent.width
              text: root.successUser
              color: root.foreground
              opacity: 0.6
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
              elide: Text.ElideRight
            }
          }

          // Error
          Column {
            anchors.centerIn: parent
            spacing: Style.space(8)
            visible: root.state === "error"

            Text {
              width: parent.width
              text: "⚠"
              color: root.foreground
              opacity: 0.8
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.statusMessage
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WrapAnywhere
            }

            Text {
              width: parent.width
              text: "Esc to close"
              color: root.foreground
              opacity: 0.5
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
            }
          }
        }
      }
    }
  }
}
