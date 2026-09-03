import QtQuick
import qs.Ui

// Bar widget: a QR-code icon button that toggles the NoMorePass overlay.
// Left click opens/closes; the overlay itself is the plugin's overlay entry.
BarWidget {
  id: root
  moduleName: "io.github.yoprogramo.omanomorepass"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uf029"
    horizontalMargin: 7.5
    tooltipText: "Receive a password with NoMorePass"
    onPressed: function(button) {
      if (!root.bar) return
      if (button === Qt.RightButton) return
      root.bar.run("omarchy-shell shell toggle io.github.yoprogramo.omanomorepass '{}'")
    }
  }
}
