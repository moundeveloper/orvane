// Reads Windows Precision Touchpad finger positions through Raw Input and
// prints two-finger movement for Orvane's canvas. Scroll (wheel) messages
// from a touchpad are locked to one axis by Windows ("rails"); finger
// positions are not, so panning from them is free in every direction.
//
// Output, one line each (fractions of the touchpad's width/height):
//   ready <touchpads>        started; number of precision touchpads found
//   m <dx> <dy>              two fingers moved by this much
//   e                        two-finger contact ended
// Compiled at runtime by PowerShell's Add-Type (see touchpad.mjs).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class OrvaneTouchpad
{
    const int WM_INPUT = 0x00FF;
    const uint RID_INPUT = 0x10000003;
    const uint RIDI_PREPARSEDDATA = 0x20000005;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const uint RIM_TYPEHID = 2;
    const int HIDP_STATUS_SUCCESS = 0x00110000;
    const ushort PAGE_GENERIC = 0x01, PAGE_DIGITIZER = 0x0D;
    const ushort USAGE_X = 0x30, USAGE_Y = 0x31, USAGE_TOUCHPAD = 0x05;
    const ushort USAGE_TIP = 0x42, USAGE_CONTACT_ID = 0x51;

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }
    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTHEADER { public uint Type; public uint Size; public IntPtr Device; public IntPtr WParam; }
    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICELIST { public IntPtr Device; public uint Type; }
    [StructLayout(LayoutKind.Sequential)]
    struct HIDP_CAPS
    {
        public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
        public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices,
            NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices,
            NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
    }
    // HIDP_VALUE_CAPS is 72 bytes; read the fields we need by offset.
    const int VALUE_CAPS_SIZE = 72;

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr rawInput, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll")]
    static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, IntPtr data, ref uint size);
    [DllImport("user32.dll")]
    static extern uint GetRawInputDeviceList(IntPtr list, ref uint count, uint size);
    [DllImport("hid.dll")]
    static extern int HidP_GetCaps(IntPtr preparsed, out HIDP_CAPS caps);
    [DllImport("hid.dll")]
    static extern int HidP_GetValueCaps(int reportType, IntPtr caps, ref ushort length, IntPtr preparsed);
    [DllImport("hid.dll")]
    static extern int HidP_GetUsageValue(int reportType, ushort usagePage, ushort linkCollection, ushort usage,
        out uint value, IntPtr preparsed, IntPtr report, uint reportLength);
    [DllImport("hid.dll")]
    static extern int HidP_GetUsages(int reportType, ushort usagePage, ushort linkCollection, [Out] ushort[] usages,
        ref uint length, IntPtr preparsed, IntPtr report, uint reportLength);

    // Per touchpad: preparsed data and, per finger collection, the X/Y ranges.
    class Device
    {
        public IntPtr Preparsed;
        public List<ushort> Collections = new List<ushort>();
        public Dictionary<ushort, double> SpanX = new Dictionary<ushort, double>(), SpanY = new Dictionary<ushort, double>();
    }
    class Finger { public double X, Y; public DateTime Seen; }

    static readonly Dictionary<IntPtr, Device> devices = new Dictionary<IntPtr, Device>();
    static readonly Dictionary<long, Finger> fingers = new Dictionary<long, Finger>();
    static bool pair;

    static Device Describe(IntPtr handle)
    {
        Device device;
        if (devices.TryGetValue(handle, out device)) return device;
        device = new Device();
        uint size = 0;
        GetRawInputDeviceInfo(handle, RIDI_PREPARSEDDATA, IntPtr.Zero, ref size);
        if (size == 0) return devices[handle] = device;
        device.Preparsed = Marshal.AllocHGlobal((int)size);
        GetRawInputDeviceInfo(handle, RIDI_PREPARSEDDATA, device.Preparsed, ref size);
        HIDP_CAPS caps;
        if (HidP_GetCaps(device.Preparsed, out caps) != HIDP_STATUS_SUCCESS) return devices[handle] = device;
        ushort count = caps.NumberInputValueCaps;
        IntPtr buffer = Marshal.AllocHGlobal(VALUE_CAPS_SIZE * Math.Max(1, (int)count));
        if (HidP_GetValueCaps(0, buffer, ref count, device.Preparsed) == HIDP_STATUS_SUCCESS)
        {
            for (int i = 0; i < count; i++)
            {
                IntPtr cap = buffer + i * VALUE_CAPS_SIZE;
                ushort page = (ushort)Marshal.ReadInt16(cap, 0);
                ushort link = (ushort)Marshal.ReadInt16(cap, 6);
                bool isRange = Marshal.ReadByte(cap, 12) != 0;
                int min = Marshal.ReadInt32(cap, 40), max = Marshal.ReadInt32(cap, 44);
                ushort usage = (ushort)Marshal.ReadInt16(cap, 56);
                if (page != PAGE_GENERIC || isRange) continue;
                // Some descriptors declare unsigned ranges with LogicalMax < 0.
                double span = max > min ? (double)(max - min) : (double)((uint)max - (uint)min);
                if (usage == USAGE_X) { device.SpanX[link] = span; if (!device.Collections.Contains(link)) device.Collections.Add(link); }
                if (usage == USAGE_Y) device.SpanY[link] = span;
            }
        }
        Marshal.FreeHGlobal(buffer);
        return devices[handle] = device;
    }

    static void Report(Device device, IntPtr report, uint length)
    {
        DateTime now = DateTime.UtcNow;
        double sumX = 0, sumY = 0;
        int moved = 0;
        var usages = new ushort[32];
        foreach (ushort link in device.Collections)
        {
            uint x, y, id;
            if (HidP_GetUsageValue(0, PAGE_GENERIC, link, USAGE_X, out x, device.Preparsed, report, length) != HIDP_STATUS_SUCCESS) continue;
            if (HidP_GetUsageValue(0, PAGE_GENERIC, link, USAGE_Y, out y, device.Preparsed, report, length) != HIDP_STATUS_SUCCESS) continue;
            if (HidP_GetUsageValue(0, PAGE_DIGITIZER, link, USAGE_CONTACT_ID, out id, device.Preparsed, report, length) != HIDP_STATUS_SUCCESS) id = link;
            uint n = (uint)usages.Length;
            bool tip = false;
            if (HidP_GetUsages(0, PAGE_DIGITIZER, link, usages, ref n, device.Preparsed, report, length) == HIDP_STATUS_SUCCESS)
                for (int i = 0; i < n; i++) if (usages[i] == USAGE_TIP) tip = true;
            long key = ((long)device.Preparsed.ToInt64() << 8) ^ id;
            double spanX, spanY;
            if (!device.SpanX.TryGetValue(link, out spanX) || spanX <= 0) spanX = 1;
            if (!device.SpanY.TryGetValue(link, out spanY) || spanY <= 0) spanY = 1;
            double fx = x / spanX, fy = y / spanY;
            Finger finger;
            if (!tip) { fingers.Remove(key); continue; }
            if (fingers.TryGetValue(key, out finger))
            {
                if (pair) { sumX += fx - finger.X; sumY += fy - finger.Y; moved++; }
                finger.X = fx; finger.Y = fy; finger.Seen = now;
            }
            else fingers[key] = new Finger { X = fx, Y = fy, Seen = now };
        }
        // Fingers not reported for a while have lifted.
        var stale = new List<long>();
        foreach (var entry in fingers) if ((now - entry.Value.Seen).TotalMilliseconds > 120) stale.Add(entry.Key);
        foreach (long key in stale) fingers.Remove(key);

        bool two = fingers.Count == 2;
        // Each finger's movement counts half: the pair's centre moves by the average.
        if (pair && two && moved > 0 && (sumX != 0 || sumY != 0))
            Console.WriteLine("m " + (sumX / 2).ToString("0.000000", CultureInfo.InvariantCulture) + " " +
                (sumY / 2).ToString("0.000000", CultureInfo.InvariantCulture));
        if (pair && !two) Console.WriteLine("e");
        pair = two;
    }

    class Sink : NativeWindow
    {
        public Sink() { CreateHandle(new CreateParams { Caption = "OrvaneTouchpad", ExStyle = 0x80 /* tool window */ }); }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_INPUT) Read(m.LParam);
            base.WndProc(ref m);
        }
    }

    static void Read(IntPtr handle)
    {
        uint headerSize = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
        uint size = 0;
        GetRawInputData(handle, RID_INPUT, IntPtr.Zero, ref size, headerSize);
        if (size == 0) return;
        IntPtr data = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(handle, RID_INPUT, data, ref size, headerSize) != size) return;
            var header = (RAWINPUTHEADER)Marshal.PtrToStructure(data, typeof(RAWINPUTHEADER));
            if (header.Type != RIM_TYPEHID) return;
            Device device = Describe(header.Device);
            if (device.Preparsed == IntPtr.Zero || device.Collections.Count == 0) return;
            uint reportSize = (uint)Marshal.ReadInt32(data, (int)headerSize);
            uint reports = (uint)Marshal.ReadInt32(data, (int)headerSize + 4);
            IntPtr first = data + (int)headerSize + 8;
            for (uint i = 0; i < reports; i++) Report(device, first + (int)(i * reportSize), reportSize);
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    static int CountTouchpads()
    {
        uint count = 0, itemSize = (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICELIST));
        GetRawInputDeviceList(IntPtr.Zero, ref count, itemSize);
        if (count == 0) return 0;
        IntPtr list = Marshal.AllocHGlobal((int)(count * itemSize));
        int touchpads = 0;
        try
        {
            GetRawInputDeviceList(list, ref count, itemSize);
            for (int i = 0; i < count; i++)
            {
                var item = (RAWINPUTDEVICELIST)Marshal.PtrToStructure(list + (int)(i * itemSize), typeof(RAWINPUTDEVICELIST));
                if (item.Type != RIM_TYPEHID) continue;
                Device device = Describe(item.Device);
                if (device.Preparsed == IntPtr.Zero) continue;
                HIDP_CAPS caps;
                if (HidP_GetCaps(device.Preparsed, out caps) == HIDP_STATUS_SUCCESS &&
                    caps.UsagePage == PAGE_DIGITIZER && caps.Usage == USAGE_TOUCHPAD) touchpads++;
            }
        }
        finally { Marshal.FreeHGlobal(list); }
        return touchpads;
    }

    // Ends with Orvane, even if Orvane crashed and never asked it to stop.
    public static void Run(int parent)
    {
        var watch = new Timer { Interval = 2000 };
        watch.Tick += (s, e) =>
        {
            try { if (System.Diagnostics.Process.GetProcessById(parent).HasExited) Application.Exit(); }
            catch (ArgumentException) { Application.Exit(); }
        };
        watch.Start();
        var sink = new Sink();
        var request = new[] { new RAWINPUTDEVICE { UsagePage = PAGE_DIGITIZER, Usage = USAGE_TOUCHPAD, Flags = RIDEV_INPUTSINK, Target = sink.Handle } };
        if (!RegisterRawInputDevices(request, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
        {
            Console.WriteLine("error register " + Marshal.GetLastWin32Error());
            return;
        }
        Console.WriteLine("ready " + CountTouchpads());
        Application.Run();
    }
}
