namespace Demo;

public static class Pipeline
{
    public static bool Valid(string name) => name.Length > 0;
    public static void Store(string name) { }
    public static string Done() => "done";
}
