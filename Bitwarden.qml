import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: root

  property string home: Quickshell.env("HOME")
  property string backend: home + "/.config/omarchy/plugins/nmorton.bitwarden/backend.mjs"
  property var shell: null
  property var manifest: null
  property bool opened: false
  property string state: "checking"
  property string statusMessage: ""
  property string sessionKey: ""
  property string masterPassword: ""
  property string filterText: ""
  property var items: []
  property int selectedIndex: 0
  property string pendingAction: ""
  property var pendingPayload: ({})
  property string copyTargetId: ""
  property string copyTargetField: ""
  property string copyFeedbackState: "idle"
  property int requestGeneration: 0
  property int runningGeneration: 0
  property bool queuedLock: false
  property string lockSession: ""

  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property color scrim: Color.menu.scrim
  property color selectedBackground: Color.menu.selectedBackground
  property color selectedText: Color.menu.selectedText
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  readonly property int cornerRadius: Style.cornerRadius
  property int contentMargin: Style.spacing.panelPadding
  property int cardWidth: Math.min(Style.space(680), panel.width - Style.gapsOut * 2)
  property int cardHeight: Math.min(Style.space(590), panel.height - Style.gapsOut * 2)
  property int rowHeight: Math.max(Style.space(52), Style.font.body + Style.font.caption + Style.spacing.controlPaddingY * 2)
  readonly property var filteredItems: {
    var needle = String(filterText || "").trim().toLowerCase()
    if (!needle) return items
    return items.filter(function(item) {
      return item.name.toLowerCase().indexOf(needle) >= 0
          || item.username.toLowerCase().indexOf(needle) >= 0
          || item.uri.toLowerCase().indexOf(needle) >= 0
    })
  }

  function open(payloadJson) {
    root.requestGeneration++
    root.opened = true
    root.filterText = ""
    root.statusMessage = ""
    root.selectedIndex = 0
    root.copyTargetId = ""
    root.copyTargetField = ""
    root.copyFeedbackState = "idle"
    if (actionProc.running) return
    if (root.sessionKey) {
      if (!sessionExpiry.running) sessionExpiry.restart()
      root.loadItems()
    } else root.checkStatus()
  }

  function forgetSession() {
    sessionExpiry.stop()
    root.sessionKey = ""
    root.items = []
    root.filterText = ""
    root.masterPassword = ""
    root.pendingPayload = ({})
    root.copyTargetId = ""
    root.copyTargetField = ""
    root.copyFeedbackState = "idle"
  }

  function close() {
    var oldSession = root.sessionKey
    root.opened = false
    root.requestGeneration++
    root.forgetSession()
    root.state = "locked"
    if (actionProc.running) {
      root.queuedLock = true
      root.lockSession = oldSession
    } else if (oldSession) root.run("lock", { session: oldSession })
  }

  function dismiss() {
    root.close()
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "nmorton.bitwarden")
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  function run(action, payload) {
    if (actionProc.running) return false
    root.pendingAction = action
    root.runningGeneration = root.requestGeneration
    root.pendingPayload = payload || ({})
    actionProc.command = ["node", root.backend, action]
    actionProc.running = true
    return true
  }

  function checkStatus() {
    root.state = "checking"
    root.run("status", {})
  }

  function unlock() {
    if (!root.masterPassword || actionProc.running) return
    root.statusMessage = "Unlocking vault…"
    root.run("unlock", { password: root.masterPassword })
  }

  function loadItems() {
    root.state = "loading"
    root.run("list", { session: root.sessionKey })
  }

  function lockVault() {
    var oldSession = root.sessionKey
    root.requestGeneration++
    root.forgetSession()
    root.state = "locked"
    root.statusMessage = "Vault locked locally."
    if (actionProc.running) {
      root.queuedLock = true
      root.lockSession = oldSession
    } else if (oldSession) root.run("lock", { session: oldSession })
    Qt.callLater(function() { if (root.opened) passwordField.forceActiveFocus() })
  }

  function copyField(item, field) {
    if (!item || !root.sessionKey || actionProc.running) return
    statusTimer.stop()
    root.copyTargetId = item.id
    root.copyTargetField = field
    root.copyFeedbackState = "copying"
    root.statusMessage = field === "password" ? "Copying password to clipboard…" : "Copying username to clipboard…"
    root.run(field === "password" ? "copy-password" : "copy-username", {
      session: root.sessionKey,
      id: item.id
    })
  }

  function handleBackendStderr(raw) {
    var errors = []
    var lines = String(raw || "").split(/\r?\n/)
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line.indexOf("BW_PLUGIN_LOG ") === 0) {
        try {
          var entry = JSON.parse(line.slice("BW_PLUGIN_LOG ".length))
          console.info("[Bitwarden] backend event=" + String(entry.event || "unknown")
            + " action=" + String(entry.action || "")
            + " operation=" + String(entry.operation || "")
            + " ok=" + String(entry.ok === undefined ? "" : entry.ok)
            + " durationMs=" + String(entry.durationMs === undefined ? "" : entry.durationMs)
            + " errorCategory=" + String(entry.errorCategory || ""))
        } catch (e) {
          console.info("[Bitwarden] malformed backend diagnostic")
        }
      } else if (line.trim()) {
        errors.push(line.trim())
      }
    }
    return errors.join("\n")
  }

  function handleResult(action, exitCode, output, errorText) {
    if (!root.opened) return
    if (exitCode !== 0) {
      if (action === "copy-password" || action === "copy-username") root.copyFeedbackState = "idle"
      if (action === "unlock" || action === "list") root.forgetSession()
      root.state = root.sessionKey ? "unlocked" : "locked"
      root.statusMessage = String(errorText || "Bitwarden operation failed.").slice(0, 180)
      return
    }

    if (action === "status") {
      var status = String(output || "").trim()
      if (status === "unlocked" && root.sessionKey) root.loadItems()
      else if (status === "unauthenticated") {
        root.state = "unauthenticated"
        root.statusMessage = "Sign in first by running bw login in a terminal."
      } else {
        root.state = "locked"
        root.statusMessage = ""
        Qt.callLater(function() { passwordField.forceActiveFocus() })
      }
    } else if (action === "unlock") {
      root.sessionKey = String(output || "").trim()
      root.masterPassword = ""
      if (!root.sessionKey) {
        root.state = "locked"
        root.statusMessage = "Bitwarden did not return an unlock session."
      } else {
        root.statusMessage = ""
        sessionExpiry.restart()
        root.loadItems()
      }
    } else if (action === "list") {
      try {
        root.items = JSON.parse(output || "[]")
        root.selectedIndex = 0
        root.state = "unlocked"
        root.statusMessage = root.items.length ? "" : "No login items found."
        Qt.callLater(function() { searchField.forceActiveFocus() })
      } catch (e) {
        root.state = "locked"
        root.sessionKey = ""
        root.items = []
        root.statusMessage = "Could not read the Bitwarden item list."
      }
    } else if (action === "lock") {
      root.sessionKey = ""
      root.items = []
      root.filterText = ""
      root.state = "locked"
      root.statusMessage = "Vault locked."
      Qt.callLater(function() { passwordField.forceActiveFocus() })
    } else if (action === "copy-password" || action === "copy-username") {
      root.copyFeedbackState = "copied"
      root.statusMessage = action === "copy-password" ? "Password copied (clears in 30 seconds)." : "Username copied (clears in 30 seconds)."
      statusTimer.restart()
    }
  }

  Process {
    id: actionProc
    running: false
    stdinEnabled: true
    stdout: StdioCollector { id: actionStdout; waitForEnd: true }
    stderr: StdioCollector { id: actionStderr; waitForEnd: true }
    onStarted: {
      write(JSON.stringify(root.pendingPayload) + "\n")
      root.pendingPayload = ({})
      if (root.pendingAction === "unlock") root.masterPassword = ""
    }
    onExited: function(exitCode) {
      var action = root.pendingAction
      var generation = root.runningGeneration
      var errorText = root.handleBackendStderr(String(actionStderr.text || ""))
      if (generation === root.requestGeneration && root.opened)
        root.handleResult(action, exitCode, String(actionStdout.text || "").trim(), errorText)
      if (action === "unlock" && exitCode === 0 && generation !== root.requestGeneration) {
        root.queuedLock = true
        if (!root.lockSession) root.lockSession = String(actionStdout.text || "").trim()
      }
      if (root.queuedLock) {
        root.queuedLock = false
        var lockSession = root.lockSession
        root.lockSession = ""
        root.run("lock", lockSession ? { session: lockSession } : {})
      } else if (generation !== root.requestGeneration && root.opened) {
        if (root.sessionKey) root.loadItems()
        else root.checkStatus()
      }
    }
  }

  Timer {
    id: sessionExpiry
    interval: 300000
    repeat: false
    onTriggered: root.lockVault()
  }

  Timer {
    id: statusTimer
    interval: 4000
    repeat: false
    onTriggered: {
      root.statusMessage = ""
      root.copyTargetId = ""
      root.copyTargetField = ""
      root.copyFeedbackState = "idle"
    }
  }

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "nmorton-bitwarden"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: root.cardWidth
      height: root.cardHeight
      radius: root.cornerRadius
      anchors.centerIn: parent
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Column {
        anchors.fill: parent
        anchors.margins: root.contentMargin
        spacing: Style.spacing.md

        Item {
          width: parent.width
          height: Style.space(40)
          Text {
            textFormat: Text.PlainText
            text: "Bitwarden"
            color: root.foreground
            font.family: Style.font.menuFamily
            font.pixelSize: Style.font.title
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }
          Text {
            textFormat: Text.PlainText
            visible: root.state === "unlocked"
            text: "Lock  Ctrl+L"
            color: root.foreground
            opacity: 0.75
            font.family: Style.font.menuFamily
            font.pixelSize: Style.font.caption
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            MouseArea { anchors.fill: parent; onClicked: root.lockVault() }
          }
        }

        TextInput {
          id: searchField
          visible: root.state === "unlocked" || root.state === "loading"
          width: parent.width
          height: Style.space(44)
          text: root.filterText
          onTextChanged: {
            root.filterText = text
            root.selectedIndex = 0
          }
          color: root.foreground
          selectionColor: root.selectedBackground
          selectedTextColor: root.selectedText
          font.family: Style.font.menuFamily
          font.pixelSize: Style.font.heading
          verticalAlignment: TextInput.AlignVCenter
          selectByMouse: true
          clip: true
          Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Escape) {
              root.dismiss()
              event.accepted = true
            } else if (event.key === Qt.Key_L && (event.modifiers & Qt.ControlModifier)) {
              root.lockVault()
              event.accepted = true
            } else if (event.key === Qt.Key_U && (event.modifiers & Qt.ControlModifier)) {
              var userItem = root.filteredItems[root.selectedIndex]
              if (userItem) root.copyField(userItem, "username")
              event.accepted = true
            } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
              var item = root.filteredItems[root.selectedIndex]
              if (item) root.copyField(item, "password")
              event.accepted = true
            } else if (event.key === Qt.Key_Down) {
              root.selectedIndex = Math.min(root.filteredItems.length - 1, root.selectedIndex + 1)
              event.accepted = true
            } else if (event.key === Qt.Key_Up) {
              root.selectedIndex = Math.max(0, root.selectedIndex - 1)
              event.accepted = true
            }
          }
          Text {
            textFormat: Text.PlainText
            anchors.fill: parent
            verticalAlignment: Text.AlignVCenter
            text: "Search logins…"
            color: root.foreground
            opacity: 0.5
            font: searchField.font
            visible: searchField.text.length === 0 && !searchField.activeFocus
          }
        }

        Text {

          textFormat: Text.PlainText
          visible: root.state === "locked"
          text: "Enter your master password to unlock"
          color: root.foreground
          font.family: Style.font.menuFamily
          font.pixelSize: Style.font.body
        }

        TextInput {
          id: passwordField
          visible: root.state === "locked"
          width: parent.width
          height: Style.space(48)
          echoMode: TextInput.Password
          text: root.masterPassword
          onTextChanged: root.masterPassword = text
          color: root.foreground
          selectionColor: root.selectedBackground
          selectedTextColor: root.selectedText
          font.family: Style.font.menuFamily
          font.pixelSize: Style.font.heading
          verticalAlignment: TextInput.AlignVCenter
          selectByMouse: false
          clip: true
          Keys.onReturnPressed: root.unlock()
          Keys.onEnterPressed: root.unlock()
          Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Escape) {
              root.dismiss()
              event.accepted = true
            } else if (event.key === Qt.Key_L && (event.modifiers & Qt.ControlModifier)) {
              root.lockVault()
              event.accepted = true
            }
          }
          Text {
            textFormat: Text.PlainText
            anchors.fill: parent
            verticalAlignment: Text.AlignVCenter
            text: "Master password"
            color: root.foreground
            opacity: 0.5
            font: passwordField.font
            visible: passwordField.text.length === 0 && !passwordField.activeFocus
          }
        }

        Text {

          textFormat: Text.PlainText
          visible: root.state === "unauthenticated"
          width: parent.width
          wrapMode: Text.Wrap
          text: "Run bw login in a terminal once, then reopen this overlay. Your login is stored by the Bitwarden CLI; the unlocked session is not."
          color: root.foreground
          font.family: Style.font.menuFamily
          font.pixelSize: Style.font.body
        }

        Text {

          textFormat: Text.PlainText
          visible: root.statusMessage.length > 0
          width: parent.width
          text: root.statusMessage
          color: root.foreground
          opacity: 1
          elide: Text.ElideRight
          font.family: Style.font.menuFamily
          font.pixelSize: Style.font.body
        }

        ListView {
          id: itemList
          visible: root.state === "unlocked" || root.state === "loading"
          width: parent.width
          height: Math.max(0, parent.height - y)
          model: root.filteredItems
          clip: true
          currentIndex: root.selectedIndex
          spacing: Style.spacing.xs
          delegate: Rectangle {
            required property int index
            required property var modelData
            width: itemList.width
            height: root.rowHeight
            radius: Style.cornerRadius
            color: index === root.selectedIndex ? root.selectedBackground : "transparent"

            Row {
              anchors.fill: parent
              anchors.leftMargin: Style.spacing.md
              anchors.rightMargin: Style.spacing.md
              spacing: Style.spacing.sm
              Column {
                width: parent.width - copyUsername.width - copyPassword.width - 2 * parent.spacing
                anchors.verticalCenter: parent.verticalCenter
                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: modelData.name
                  color: index === root.selectedIndex ? root.selectedText : root.foreground
                  font.family: Style.font.menuFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }
                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: modelData.username || modelData.uri || "No username"
                  color: index === root.selectedIndex ? root.selectedText : root.foreground
                  opacity: 0.65
                  font.family: Style.font.menuFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }
              Rectangle {
                id: copyUsername
                width: Style.space(124)
                height: Style.space(34)
                radius: Style.cornerRadius
                color: usernameMouse.containsMouse ? root.selectedBackground : "transparent"
                border.color: root.border
                border.width: Style.normalBorderWidth
                anchors.verticalCenter: parent.verticalCenter
                Text {
                  textFormat: Text.PlainText
                  id: copyUsernameLabel
                  anchors.centerIn: parent
                  text: !modelData.username ? "No username"
                    : root.copyTargetId === modelData.id && root.copyTargetField === "username" && root.copyFeedbackState === "copying" ? "Copying…"
                    : root.copyTargetId === modelData.id && root.copyTargetField === "username" && root.copyFeedbackState === "copied" ? "Copied"
                    : "Copy username"
                  color: usernameMouse.containsMouse ? root.selectedText : root.foreground
                  opacity: modelData.username ? 1 : 0.55
                  font.family: Style.font.menuFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
                MouseArea {
                  id: usernameMouse
                  anchors.fill: parent
                  enabled: Boolean(modelData.username)
                  hoverEnabled: true
                  cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: {
                    root.selectedIndex = index
                    root.copyField(modelData, "username")
                  }
                }
              }
              Rectangle {
                id: copyPassword
                width: Style.space(124)
                height: Style.space(34)
                radius: Style.cornerRadius
                color: passwordMouse.containsMouse ? root.selectedBackground : "transparent"
                border.color: root.border
                border.width: Style.normalBorderWidth
                anchors.verticalCenter: parent.verticalCenter
                Text {
                  textFormat: Text.PlainText
                  id: copyPasswordLabel
                  anchors.centerIn: parent
                  text: root.copyTargetId === modelData.id && root.copyTargetField === "password" && root.copyFeedbackState === "copying" ? "Copying…"
                    : root.copyTargetId === modelData.id && root.copyTargetField === "password" && root.copyFeedbackState === "copied" ? "Copied"
                    : "Copy password"
                  color: passwordMouse.containsMouse ? root.selectedText : root.foreground
                  font.family: Style.font.menuFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
                MouseArea {
                  id: passwordMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: {
                    root.selectedIndex = index
                    root.copyField(modelData, "password")
                  }
                }
              }
            }
            MouseArea {
              anchors.fill: parent
              z: -1
              onClicked: root.selectedIndex = index
              onDoubleClicked: root.copyField(modelData, "password")
            }
          }
        }

        Text {

          textFormat: Text.PlainText
          visible: root.state === "unlocked"
          width: parent.width
          text: "↑/↓ select   Enter copy password   Ctrl+U copy username   Esc close"
          color: root.foreground
          opacity: 0.58
          font.family: Style.font.menuFamily
          font.pixelSize: Style.font.caption
        }
      }

    }
  }
}
