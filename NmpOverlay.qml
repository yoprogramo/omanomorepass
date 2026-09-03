import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

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
  // One file per ticket: a fixed path would hit QML's image cache, which
  // serves the first decode forever for an unchanged URL — the second open
  // would paint the previous (already consumed) QR.
  property string qrPngPath: ""

  property bool opened: false
  property string site: "omarchy"
  property int timeoutSecs: 90
  // idle | requesting | waiting | success | error
  property string state: "idle"
  property string statusMessage: ""
  property string successUser: ""
  property string qrImageSource: ""

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

  // console.log from user plugins does not reach journald; this logger does.
  // Messages are redacted before they get here: never the password.
  readonly property string logSh: Qt.resolvedUrl("log.sh").toString().replace("file://", "")
  function nlog(msg) {
    Quickshell.execDetached([root.logSh, String(msg)])
  }

  function open(payloadJson) {
    var payload = {}
    try { payload = JSON.parse(payloadJson || "{}") } catch (e) { payload = {} }
    // Default site carries a timestamp: the phone app shows the site when
    // confirming the send, so a mismatch against the card label instantly
    // reveals a scan of a stale QR.
    root.site = typeof payload.site === "string" && payload.site ? payload.site : ("omarchy-" + Qt.formatDateTime(new Date(), "HHmmss"))
    root.timeoutSecs = typeof payload.timeout === "number" && payload.timeout > 0 ? payload.timeout : 90
    nlog("open (site=" + root.site + " timeout=" + root.timeoutSecs + "s)")
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
    qrEncProc.running = false
    cleanupPng.running = true
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open("{}")
  }

  // Node is resolved from PATH at spawn time, with well-known fallback
  // locations, so the plugin is not tied to one machine's install layout.
  function startHelper() {
    helperProc.command = [
      "bash", "-c",
      'NODE="$(command -v node || command -v nodejs)"; ' +
      'if [ -z "$NODE" ]; then ' +
      'for c in "$HOME/.local/share/mise/shims/node" "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node /usr/bin/nodejs; do ' +
      '[ -x "$c" ] && NODE="$c" && break; done; fi; ' +
      '[ -n "$NODE" ] || { echo "Node.js not found. Install Node.js to use this plugin." >&2; exit 127; }; ' +
      'exec "$NODE" "$@"',
      "nmp-helper",
      root.helperPath, "--site", root.site, "--timeout", String(root.timeoutSecs)
    ]
    helperProc.running = true
  }

  function handleEvent(ev) {
    if (!ev || !ev.event) return
    // Redacted log line: never the password.
    nlog("event=" + ev.event + (ev.event === "credentials" ? " (credentials received)" : (ev.message ? " msg=" + ev.message : "")))
    switch (ev.event) {
    case "status":
      break
    case "qr":
      root.statusMessage = "Waiting for scan…"
      root.qrPngPath = "/tmp/omanomorepass-qr-" + Date.now() + ".png"
      root.qrImageSource = ""
      qrEncProc.command = ["qrencode", "-o", root.qrPngPath, "-t", "PNG", "-s", "10", "-m", "2", ev.text]
      qrEncProc.running = true
      break
    case "credentials":
      root.copyCredential(ev)
      break
    case "denied":
      root.state = "error"
      root.statusMessage = "The send was rejected from the phone."
      break
    case "expired":
      root.state = "error"
      root.statusMessage = "The ticket expired. Please try again."
      break
    case "timeout":
      root.state = "error"
      root.statusMessage = "Timed out waiting for a scan."
      break
    case "error":
      root.state = "error"
      root.statusMessage = ev.message || "Unknown error in the NoMorePass protocol."
      break
    }
  }

  function copyCredential(ev) {
    var secret = ev.password || ""
    if (!secret && ev.user) secret = ev.user
    if (!secret) {
      root.state = "error"
      root.statusMessage = "The received credential is empty."
      return
    }
    root.successUser = ev.user || ""
    // wl-copy inherits WAYLAND_DISPLAY; the secret travels through the
    // environment (never argv) and bash pipes it into wl-copy's stdin.
    copyProc.environment = ({ "NMP_SECRET": secret })
    copyProc.running = true
    root.state = "success"
    root.statusMessage = "Copied to clipboard"
    autoCloseTimer.restart()
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
    id: spinnerTimer
    interval: 80
    running: root.busy
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
    stdout: SplitParser {
      onRead: function(data) {
        try { root.handleEvent(JSON.parse(data)) } catch (e) {
          root.nlog("non-JSON stdout from helper: " + data)
        }
      }
    }
    stderr: SplitParser {
      onRead: function(data) {
        root.nlog("helper-stderr: " + data)
      }
    }
    onExited: function(exitCode, exitStatus) {
      nlog("helper exited code=" + exitCode)
      if (exitCode === 127 && root.state === "requesting") {
        root.state = "error"
        root.statusMessage = "Node.js was not found. Install Node.js to use this plugin."
      }
    }
  }

  Process {
    id: qrEncProc
    onExited: function(exitCode, exitStatus) {
      if (exitCode === 0) {
        root.qrImageSource = "file://" + root.qrPngPath
        root.state = "waiting"
      } else {
        nlog("qrencode failed code=" + exitCode)
        root.state = "error"
        root.statusMessage = "Could not render the QR code."
      }
    }
  }

  Process {
    id: cleanupPng
    command: ["bash", "-c", "rm -f /tmp/omanomorepass-qr-*.png"]
  }

  Process {
    id: copyProc
    command: ["bash", "-c", "printf '%s' \"$NMP_SECRET\" | wl-copy"]
    onStarted: nlog("wl-copy started pid=" + processId)
    onExited: function(exitCode, exitStatus) {
      nlog("wl-copy exited code=" + exitCode)
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
            visible: root.state === "requesting"

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
