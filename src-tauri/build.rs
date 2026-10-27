fn main() {
    // 图标是编译期嵌进 exe 资源里的（build.rs 生成 resource.rc，编译成 resource.lib
    // 再链进去）。但 tauri_build 只声明了 tauri.conf.json 和 capabilities 两项
    // rerun-if-changed，icons/ 不在里面——换了图标 cargo 认为什么都没变，
    // 不重跑 build.rs，于是链进去的还是上一次那份 resource.lib，exe 图标纹丝不动。
    // 而且这种失败是无声的：编译照样成功，只有去看 exe 才发现图标是旧的。
    //
    // 目录形式会被 cargo 递归监视，icons/ 下任何一个文件变了都会重跑。
    //
    // 前端文件不用管：那些是 generate_context! 宏用 include_bytes 拉进去的，
    // cargo 本来就追踪得到。
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
