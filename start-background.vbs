' Launches the Task Manager server silently in the background.
' No console window appears. Notifications still work.
Dim objShell, strDir, strNode
Set objShell = CreateObject("WScript.Shell")

strDir  = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
strNode = """C:\Program Files\nodejs\node.exe"""

' Start server hidden (0 = hidden window, False = don't wait)
objShell.Run strNode & " """ & strDir & "\server.js""", 0, False

' Open browser after 2 seconds
WScript.Sleep 2000
objShell.Run "http://localhost:3000", 1, False
