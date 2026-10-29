// Query the Windows Shell's real zero-selection menu using only isolated fixture keys.
// No menu is displayed and no command is invoked.
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32;

public static class DevPortDirectoryMenuProbe
{
    [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellFolder
    {
        void ParseDisplayName(IntPtr hwnd, IntPtr bind, [MarshalAs(UnmanagedType.LPWStr)] string name, ref uint eaten, out IntPtr pidl, ref uint attributes);
        void EnumObjects(IntPtr hwnd, uint flags, out IntPtr items);
        void BindToObject(IntPtr pidl, IntPtr bind, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
        void BindToStorage(IntPtr pidl, IntPtr bind, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
        [PreserveSig] int CompareIDs(IntPtr param, IntPtr a, IntPtr b);
        void CreateViewObject(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
    }

    [ComImport, Guid("000214E4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IContextMenu
    {
        [PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DefaultContextMenu
    {
        public IntPtr hwnd, callback, folderPidl, folder;
        public uint itemCount;
        public IntPtr items, associations;
        public uint keyCount;
        public IntPtr keys;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint mask, out uint attributes);
    [DllImport("shell32.dll")] private static extern int SHGetDesktopFolder(out IShellFolder folder);
    [DllImport("shell32.dll")] private static extern int SHCreateDefaultContextMenu(ref DefaultContextMenu definition, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll")] private static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int max, uint flags);

    public static string[] ReadBackground(string directory, string fixtureKey)
    {
        // Never read or mutate the user's real Explorer registrations in installer tests.
        if (!System.Text.RegularExpressions.Regex.IsMatch(fixtureKey, @"^Software\\DevPortInstallerTests\\[a-f0-9]{32}\\Classes\\Directory\\Background$"))
            throw new ArgumentException("Expected an isolated installer fixture key");
        using (var key = Registry.CurrentUser.OpenSubKey(fixtureKey))
        {
            if (key == null) throw new ArgumentException("Fixture key does not exist");
            IntPtr pidl = IntPtr.Zero, menu = IntPtr.Zero, folderPointer = IntPtr.Zero, keys = IntPtr.Zero;
            IShellFolder desktop = null;
            object folder = null, context = null;
            try
            {
                uint attributes;
                Marshal.ThrowExceptionForHR(SHParseDisplayName(directory, IntPtr.Zero, out pidl, 0, out attributes));
                Marshal.ThrowExceptionForHR(SHGetDesktopFolder(out desktop));
                Guid folderId = typeof(IShellFolder).GUID, menuId = typeof(IContextMenu).GUID;
                desktop.BindToObject(pidl, IntPtr.Zero, ref folderId, out folder);
                folderPointer = Marshal.GetComInterfaceForObject(folder, typeof(IShellFolder));
                keys = Marshal.AllocCoTaskMem(IntPtr.Size);
                Marshal.WriteIntPtr(keys, key.Handle.DangerousGetHandle());
                var definition = new DefaultContextMenu { folderPidl = pidl, folder = folderPointer, keyCount = 1, keys = keys };
                Marshal.ThrowExceptionForHR(SHCreateDefaultContextMenu(ref definition, ref menuId, out context));
                menu = CreatePopupMenu();
                if (menu == IntPtr.Zero) throw new InvalidOperationException("CreatePopupMenu failed");
                Marshal.ThrowExceptionForHR(((IContextMenu)context).QueryContextMenu(menu, 0, 1, 32767, 0));
                int count = GetMenuItemCount(menu);
                if (count < 0) throw new InvalidOperationException("GetMenuItemCount failed");
                var result = new string[count];
                for (uint i = 0; i < result.Length; i++)
                {
                    var text = new StringBuilder(1024);
                    GetMenuString(menu, i, text, text.Capacity, 0x400);
                    result[i] = text.ToString();
                }
                return result;
            }
            finally
            {
                if (menu != IntPtr.Zero) DestroyMenu(menu);
                if (context != null) Marshal.ReleaseComObject(context);
                if (keys != IntPtr.Zero) Marshal.FreeCoTaskMem(keys);
                if (folderPointer != IntPtr.Zero) Marshal.Release(folderPointer);
                if (folder != null) Marshal.ReleaseComObject(folder);
                if (desktop != null) Marshal.ReleaseComObject(desktop);
                if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
            }
        }
    }
}
