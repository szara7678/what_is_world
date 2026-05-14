param(
  [string]$TitleLike = "what_is_world",
  [string]$OutDir = "C:\Users\user\Desktop\wiw-shots",
  [switch]$ActivateTab,
  [int]$TabIndex = 2
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public class WinCap {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public class WinInfo { public IntPtr H; public string T; public int W; public int Hgt; }
  public static List<WinInfo> ListWindows() {
    var r = new List<WinInfo>();
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      var t = sb.ToString();
      if (t.Length == 0) return true;
      RECT rc; GetWindowRect(h, out rc);
      r.Add(new WinInfo { H = h, T = t, W = rc.R - rc.L, Hgt = rc.B - rc.T });
      return true;
    }, IntPtr.Zero);
    return r;
  }
  public static bool Capture(IntPtr hWnd, string outPath) {
    RECT rc; if (!GetWindowRect(hWnd, out rc)) return false;
    int w = rc.R - rc.L; int h = rc.B - rc.T;
    if (w <= 0 || h <= 0) return false;
    using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(hWnd, hdc, 2);
        g.ReleaseHdc(hdc);
      }
      bmp.Save(outPath, ImageFormat.Png);
    }
    return true;
  }
  public static void Activate(IntPtr hWnd) {
    ShowWindow(hWnd, 9);
    SetForegroundWindow(hWnd);
  }
}
'@ -Language CSharp -ReferencedAssemblies System.Drawing,System.Windows.Forms

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$wins = [WinCap]::ListWindows()
$chrome = $wins | Where-Object { $_.T -like "*Chrome*" -and $_.W -gt 200 } | Sort-Object -Property Hgt -Descending | Select-Object -First 1
if (-not $chrome) { Write-Output "No Chrome window found"; exit 1 }

if ($ActivateTab) {
  Add-Type -AssemblyName System.Windows.Forms
  [WinCap]::Activate($chrome.H)
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait("^$TabIndex")
  Start-Sleep -Milliseconds 400
}

$stamp = Get-Date -Format "HHmmss"
$out = Join-Path $OutDir ("wiw-" + $stamp + ".png")
$ok = [WinCap]::Capture($chrome.H, $out)
Write-Output ("CAPTURED: " + $ok + " | " + $chrome.W + "x" + $chrome.Hgt + " | " + $chrome.T + " | " + $out)
