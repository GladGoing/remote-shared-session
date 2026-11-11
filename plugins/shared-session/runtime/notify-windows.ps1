$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [Uri]$payload.url
if (-not ($target.Scheme -eq 'https' -or ($target.Scheme -eq 'http' -and $target.IsLoopback))) { throw 'invalid_notification_url' }
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$escaped = [System.Security.SecurityElement]::Escape($target.AbsoluteUri)
$title = [System.Security.SecurityElement]::Escape([string]$payload.title)
$body = [System.Security.SecurityElement]::Escape([string]$payload.body)
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('<toast activationType="protocol" launch="' + $escaped + '"><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = 'shared-session'
$toast.Group = 'shared-session'
$toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(5)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)
