# STA overlay: rounded teal pill near 17% of primary-monitor height.
# Physical Esc (not SendInput) writes "esc" to stdout and exits.
# Plugin process owns this child and kills it when control tools finish.
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class OcuBannerForm : Form {
  public OcuBannerForm() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    AutoScaleMode = AutoScaleMode.None;
    ControlBox = false;
    MinimizeBox = false;
    MaximizeBox = false;
    DoubleBuffered = false;
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x00080000; // WS_EX_LAYERED
      cp.ExStyle |= 0x00000008; // WS_EX_TOPMOST
      cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
      cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
      cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT click-through
      return cp;
    }
  }
  protected override void OnPaint(PaintEventArgs e) { }
  protected override void OnPaintBackground(PaintEventArgs e) { }
}

public static class OcuBanner {
  const int WH_KEYBOARD_LL = 13;
  const int WM_KEYDOWN = 0x0100;
  const int WM_SYSKEYDOWN = 0x0104;
  const uint LLKHF_INJECTED = 0x10;
  const uint VK_ESCAPE = 0x1B;
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint MONITOR_DEFAULTTOPRIMARY = 1;
  const int ULW_ALPHA = 2;
  const int AC_SRC_OVER = 0;
  const int AC_SRC_ALPHA = 1;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
  static extern IntPtr GetModuleHandle(string lpModuleName);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdi);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr ho);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint iUsage, out IntPtr ppvBits, IntPtr hSection, uint dwOffset);

  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)]
  struct SIZE { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BLENDFUNCTION {
    public byte BlendOp;
    public byte BlendFlags;
    public byte SourceConstantAlpha;
    public byte AlphaFormat;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFOHEADER {
    public int biSize;
    public int biWidth;
    public int biHeight;
    public short biPlanes;
    public short biBitCount;
    public int biCompression;
    public int biSizeImage;
    public int biXPelsPerMeter;
    public int biYPelsPerMeter;
    public int biClrUsed;
    public int biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFO {
    public BITMAPINFOHEADER bmiHeader;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct KBDLLHOOKSTRUCT {
    public uint vkCode;
    public uint scanCode;
    public uint flags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  static IntPtr _hook = IntPtr.Zero;
  static HookProc _proc;
  static OcuBannerForm _form;
  static Bitmap _bmp;
  static bool _signaled;
  static int _x;
  static int _y;

  static IntPtr Hook(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      int msg = wParam.ToInt32();
      if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
        KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        bool injected = (info.flags & LLKHF_INJECTED) != 0;
        if (info.vkCode == VK_ESCAPE && !injected) {
          RequestStop();
          return (IntPtr)1;
        }
      }
    }
    return CallNextHookEx(_hook, nCode, wParam, lParam);
  }

  static void RequestStop() {
    if (_signaled) return;
    _signaled = true;
    if (_form != null && _form.IsHandleCreated) {
      _form.BeginInvoke(new MethodInvoker(DoExit));
    } else {
      DoExit();
    }
  }

  static void DoExit() {
    try {
      Console.WriteLine("esc");
      Console.Out.Flush();
    } catch {
    }
    Application.Exit();
  }

  static void KeepTop(object sender, EventArgs e) {
    if (_form == null || !_form.IsHandleCreated) return;
    SetWindowPos(_form.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  static RECT PrimaryMonitor() {
    POINT pt;
    pt.x = 0;
    pt.y = 0;
    IntPtr mon = MonitorFromPoint(pt, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (mon != IntPtr.Zero && GetMonitorInfo(mon, ref info)) return info.rcMonitor;
    RECT fallback = new RECT();
    fallback.Left = 0;
    fallback.Top = 0;
    fallback.Right = Screen.PrimaryScreen.Bounds.Width;
    fallback.Bottom = Screen.PrimaryScreen.Bounds.Height;
    return fallback;
  }

  static FontFamily PickFamily() {
    string[] names = new string[] {
      "HarmonyOS Sans SC",
      "MiSans",
      "Source Han Sans SC",
      "Noto Sans SC",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
      "Segoe UI"
    };
    for (int i = 0; i < names.Length; i++) {
      try { return new FontFamily(names[i]); } catch { }
    }
    return FontFamily.GenericSansSerif;
  }

  static void ZeroArgb(Bitmap bmp) {
    Rectangle rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
    BitmapData data = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    try {
      int n = Math.Abs(data.Stride) * bmp.Height;
      byte[] z = new byte[n];
      Marshal.Copy(z, 0, data.Scan0, n);
    } finally {
      bmp.UnlockBits(data);
    }
  }

  static void Premultiply(Bitmap bmp) {
    Rectangle rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
    BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    try {
      int stride = data.Stride;
      int w = bmp.Width;
      int h = bmp.Height;
      byte[] row = new byte[Math.Abs(stride)];
      IntPtr scan = data.Scan0;
      for (int y = 0; y < h; y++) {
        IntPtr p = new IntPtr(scan.ToInt64() + (long)y * stride);
        Marshal.Copy(p, row, 0, w * 4);
        for (int x = 0; x < w; x++) {
          int i = x * 4;
          int a = row[i + 3];
          if (a == 0 && (row[i] | row[i + 1] | row[i + 2]) != 0) {
            a = 255;
            row[i + 3] = 255;
          }
          if (a == 0) {
            row[i] = 0;
            row[i + 1] = 0;
            row[i + 2] = 0;
          } else if (a < 255) {
            row[i] = (byte)((row[i] * a) / 255);
            row[i + 1] = (byte)((row[i + 1] * a) / 255);
            row[i + 2] = (byte)((row[i + 2] * a) / 255);
          }
        }
        Marshal.Copy(row, 0, p, w * 4);
      }
    } finally {
      bmp.UnlockBits(data);
    }
  }

  static void DrawGlassText(Graphics g, GraphicsPath path) {
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    g.CompositingQuality = CompositingQuality.HighQuality;

    Matrix drop = new Matrix();
    drop.Translate(0f, 2.5f);
    GraphicsPath shadow = (GraphicsPath)path.Clone();
    shadow.Transform(drop);
    using (Pen shadowPen = new Pen(Color.FromArgb(70, 40, 70, 95), 5.5f)) {
      shadowPen.LineJoin = LineJoin.Round;
      g.DrawPath(shadowPen, shadow);
    }
    using (SolidBrush shadowFill = new SolidBrush(Color.FromArgb(48, 50, 85, 110))) {
      g.FillPath(shadowFill, shadow);
    }
    shadow.Dispose();

    RectangleF pb = path.GetBounds();
    using (LinearGradientBrush fill = new LinearGradientBrush(pb,
      Color.FromArgb(242, 214, 240, 252),
      Color.FromArgb(242, 64, 164, 226),
      LinearGradientMode.Vertical)) {
      ColorBlend blend = new ColorBlend();
      blend.Positions = new float[] { 0f, 0.42f, 0.75f, 1f };
      blend.Colors = new Color[] {
        Color.FromArgb(246, 232, 248, 255),
        Color.FromArgb(240, 125, 211, 250),
        Color.FromArgb(240, 62, 170, 234),
        Color.FromArgb(240, 34, 134, 205)
      };
      fill.InterpolationColors = blend;
      g.FillPath(fill, path);
    }

    Region clip = g.Clip;
    g.SetClip(new RectangleF(pb.X, pb.Y, pb.Width, pb.Height * 0.5f));
    using (LinearGradientBrush shine = new LinearGradientBrush(pb,
      Color.FromArgb(120, 255, 255, 255),
      Color.FromArgb(0, 255, 255, 255),
      LinearGradientMode.Vertical)) {
      g.FillPath(shine, path);
    }
    g.Clip = clip;

    using (Pen edge = new Pen(Color.FromArgb(130, 255, 255, 255), 1.1f)) {
      edge.LineJoin = LineJoin.Round;
      g.DrawPath(edge, path);
    }
  }

  static Bitmap RenderBanner(string text) {
    FontFamily family = PickFamily();
    float em = 32f;
    GraphicsPath path = new GraphicsPath();
    path.AddString(text, family, (int)FontStyle.Bold, em, new PointF(0f, 0f), StringFormat.GenericTypographic);
    RectangleF bounds = path.GetBounds();
    int pad = 10;
    int w = Math.Max(32, (int)Math.Ceiling(bounds.Width) + pad * 2);
    int h = Math.Max(32, (int)Math.Ceiling(bounds.Height) + pad * 2);
    if (bounds.Width < 1f || bounds.Height < 1f) {
      path.Dispose();
      path = new GraphicsPath();
      path.AddString(text, family, (int)FontStyle.Bold, em, new PointF(pad, pad), StringFormat.GenericDefault);
    } else {
      Matrix shift = new Matrix();
      shift.Translate(pad - bounds.X, pad - bounds.Y);
      path.Transform(shift);
    }

    Bitmap bmp = new Bitmap(w, h + 4, PixelFormat.Format32bppArgb);
    ZeroArgb(bmp);
    Graphics g = Graphics.FromImage(bmp);
    DrawGlassText(g, path);
    path.Dispose();
    g.Dispose();
    Premultiply(bmp);
    return bmp;
  }

  static bool ApplyLayered(Form form, Bitmap bmp) {
    if (form == null || !form.IsHandleCreated || bmp == null) return false;
    IntPtr screenDc = GetDC(IntPtr.Zero);
    IntPtr memDc = CreateCompatibleDC(screenDc);
    IntPtr hBmp = IntPtr.Zero;
    IntPtr old = IntPtr.Zero;
    try {
      BITMAPINFO bi = new BITMAPINFO();
      bi.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
      bi.bmiHeader.biWidth = bmp.Width;
      bi.bmiHeader.biHeight = -bmp.Height;
      bi.bmiHeader.biPlanes = 1;
      bi.bmiHeader.biBitCount = 32;
      bi.bmiHeader.biCompression = 0;
      IntPtr bits;
      hBmp = CreateDIBSection(memDc, ref bi, 0, out bits, IntPtr.Zero, 0);
      if (hBmp == IntPtr.Zero || bits == IntPtr.Zero) return false;
      Rectangle rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
      BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        int srcStride = data.Stride;
        int dstStride = bmp.Width * 4;
        byte[] row = new byte[dstStride];
        for (int y = 0; y < bmp.Height; y++) {
          IntPtr src = new IntPtr(data.Scan0.ToInt64() + (long)y * srcStride);
          IntPtr dst = new IntPtr(bits.ToInt64() + (long)y * dstStride);
          Marshal.Copy(src, row, 0, dstStride);
          Marshal.Copy(row, 0, dst, dstStride);
        }
      } finally {
        bmp.UnlockBits(data);
      }
      old = SelectObject(memDc, hBmp);
      POINT dstPos;
      dstPos.x = form.Left;
      dstPos.y = form.Top;
      SIZE size;
      size.cx = bmp.Width;
      size.cy = bmp.Height;
      POINT srcPos;
      srcPos.x = 0;
      srcPos.y = 0;
      BLENDFUNCTION blend;
      blend.BlendOp = AC_SRC_OVER;
      blend.BlendFlags = 0;
      blend.SourceConstantAlpha = 255;
      blend.AlphaFormat = AC_SRC_ALPHA;
      return UpdateLayeredWindow(form.Handle, screenDc, ref dstPos, ref size, memDc, ref srcPos, 0, ref blend, ULW_ALPHA);
    } catch {
      return false;
    } finally {
      if (old != IntPtr.Zero) SelectObject(memDc, old);
      if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
      if (memDc != IntPtr.Zero) DeleteDC(memDc);
      if (screenDc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDc);
    }
  }

  static void HideBroken(Form form) {
    try {
      form.Size = new Size(1, 1);
      form.Location = new Point(-32000, -32000);
      form.Hide();
    } catch {
    }
  }

  public static void Run(string text) {
    try { SetProcessDpiAwareness(2); } catch {
      try { SetProcessDPIAware(); } catch { }
    }
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);

    if (string.IsNullOrEmpty(text)) {
      text = "AI is controlling this PC. Press ESC to stop.";
    }

    Bitmap bmp = RenderBanner(text);
    string dump = Environment.GetEnvironmentVariable("OCU_BANNER_DUMP");
    if (!string.IsNullOrEmpty(dump)) {
      try { bmp.Save(dump, ImageFormat.Png); } catch { }
      bmp.Dispose();
      return;
    }

    RECT mon = PrimaryMonitor();
    int monH = mon.Bottom - mon.Top;
    int monW = mon.Right - mon.Left;
    _x = mon.Left + Math.Max(0, (monW - bmp.Width) / 2);
    _y = mon.Top + (int)Math.Round(monH * 0.17) - bmp.Height / 2;
    if (_y < mon.Top) _y = mon.Top;
    if (_y + bmp.Height > mon.Bottom) _y = mon.Bottom - bmp.Height;

    OcuBannerForm form = new OcuBannerForm();
    form.Location = new Point(_x, _y);
    form.ClientSize = new Size(bmp.Width, bmp.Height);
    _form = form;
    _bmp = bmp;
    _proc = new HookProc(Hook);
    form.HandleCreated += new EventHandler(OnHandleCreated);
    form.Load += new EventHandler(OnLoad);
    form.FormClosed += new FormClosedEventHandler(OnFormClosed);

    Timer timer = new Timer();
    timer.Interval = 400;
    timer.Tick += new EventHandler(KeepTop);
    timer.Start();

    Application.Run(form);
  }

  static void OnHandleCreated(object sender, EventArgs e) {
    IntPtr mod = GetModuleHandle(null);
    _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, mod, 0);
    if (!ApplyLayered(_form, _bmp)) HideBroken(_form);
  }

  static void OnLoad(object sender, EventArgs e) {
    if (!ApplyLayered(_form, _bmp)) HideBroken(_form);
  }

  static void OnFormClosed(object sender, FormClosedEventArgs e) {
    if (_hook != IntPtr.Zero) {
      UnhookWindowsHookEx(_hook);
      _hook = IntPtr.Zero;
    }
    if (_bmp != null) {
      _bmp.Dispose();
      _bmp = null;
    }
  }
}
"@

$text = $env:OCU_BANNER_TEXT
if ([string]::IsNullOrWhiteSpace($text)) {
  $text = "AI 正在控制你的电脑进行作业，可以按 ESC 强行打断"
}
[OcuBanner]::Run($text)
