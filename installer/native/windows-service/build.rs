// Windows PE resource embedding — sets the executable icon to viewlba.ico
// This makes Explorer, Task Manager, and Properties show the official ViewLBA logo.
//
// Source: installer/branding/generated/windows/viewlba.ico (generated from public/logo-mark.svg)
// Mision W: Branding oficial del instalador.

fn main() {
    #[cfg(target_os = "windows")]
    {
        let ico_path = "../../branding/generated/windows/viewlba.ico";
        if std::path::Path::new(ico_path).exists() {
            // Embed the icon resource into the PE executable
            embed_resource::compile("viewlba.rc", embed_resource::NONE);
        } else {
            println!("cargo:warning=viewlba.ico not found at {} — PE icon will be default", ico_path);
        }
    }
}
