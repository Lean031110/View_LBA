// build.rs — embed viewlba.ico into the PE resources of viewlba-init.exe
fn main() {
    #[cfg(target_os = "windows")]
    {
        let ico_path = "../../branding/generated/windows/viewlba.ico";
        if std::path::Path::new(ico_path).exists() {
            embed_resource::compile("viewlba.rc", embed_resource::NONE);
        } else {
            println!("cargo:warning=viewlba.ico not found at {} — PE icon will be default", ico_path);
        }
    }
}
