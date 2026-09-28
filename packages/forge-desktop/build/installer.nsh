# forge 自定义 NSIS 安装脚本片段（electron-builder.yml → nsis.include 注入）。
#
# 背景：配置层已改用官方安装向导（oneClick:false + allowToChangeInstallationDirectory:true），
# 首装/手动重装显示标准「选择安装位置」页（预填默认 per-user 目录，可点「更改」自定义）。
# 本文件负责把 electron-updater 的更新体验补回与旧 oneClick 等价：**可见进度 + 零点击 +
# 装完自动重开**。向导模式与 oneClick 的差异共两处，逐一在此抹平：
#
# 1)「安装模式」页（Just me / Everyone）：forge 恒 per-user（perMachine:false），
#   该页纯噪音。官方 multiUserUi 的 PRE 逻辑在显示页面前检查 $isForceCurrentInstall=="1"，
#   命中则直接 setInstallModePerUser + Abort（跳过页面）。
# 2) 更新收尾：官方 installSection.nsh 在向导模式下只在「静默 + --force-run」时自动拉起
#   应用（因为正常向导有结束页「运行」勾选）。而 electron-updater 更新恒传
#   --updated --force-run 且**非静默**（isSilent=false 由契约测试守护），若不处理会停在
#   结束页等用户点「完成」。customInstall 在安装段末尾（文件复制、快捷方式注册之后）
#   复刻 oneClick 分支收尾：HideWindow + StartApp + quitSuccess(Quit) —— 不进结束页。
#   目录页更新路径无需本文件处理：模板对 MUI_PAGE_DIRECTORY 自带 skipPageIfUpdated（--updated 跳过）。
#   （目录页**首装**文案由本文件定制，见下方 MUI_DIRECTORYPAGE_TEXT_TOP。）
#
# 展开时机：app-builder-lib 的 scriptGenerator 把本文件 !include 在模板 installer.nsi
# 最顶部，因此模板中所有 !ifmacrodef 检查（customInstallMode / customInstall / customInit）
# 都能看到这里定义的宏。宏名大小写不敏感（makensis 3.0.4.1 实测）：模板里
# !ifmacrodef customInstallmode（小写 m）与本宏定义 customInstallMode 视为同名。

!ifndef BUILD_UNINSTALLER
  # ── 目录页文案：在官方默认文案基础上加一行「自动补 forge 子目录」说明 ──────────
  # 背景：官方模板 instFilesPre 在点击「安装」切页瞬间把不以 forge 结尾的路径自动
  #   补上 \forge（选 D:\软件 → 实装 D:\软件\forge），但目录页预览看不到这一点，
  #   用户会以为装到了所选路径本身。
  # 做法：MUI2 官方扩展点 MUI_DIRECTORYPAGE_TEXT_TOP（Directory.nsh L38 MUI_DEFAULT
  #   兜底、L47 DirText 透传、L61 页生成后即 !undef 不泄漏到后续页；本文件被
  #   scriptGenerator !include 在模板 installer.nsi 最顶部、先于 MUI_PAGE_DIRECTORY
  #   展开点，因此生效）。
  # 代价（有意接受）：该文案是不走 LangString 的 DirText 原文，全语言统一显示中文；
  #   运行时引用 $(^NameDA)/$_CLICK 在自定义文案中不解析，故全文手写静态文案，
  #   措辞对齐 SimpChinese.nlf 默认文案。
  # 备注：目录页 SHOW 回调路线已证伪 —— NSIS 3.0.4.1 对内建 directory 页编译期消费
  #   页级 CUSTOMFUNCTION SHOW define、但运行时不派发（2026-09-19 真机弹窗/日志双
  #   重探针验证均无触发），故改用上述编译期文案方案。
  !define MUI_DIRECTORYPAGE_TEXT_TOP "Setup 将安装 Forge 在下列文件夹。$\r$\n$\r$\n要安装到不同文件夹，单击 [浏览(B)...] 并选择其他的文件夹。$\r$\n$\r$\n提示：若所选路径不以 Forge 结尾，点击「安装」后将自动安装到其下的 Forge 子目录（例如选择 D:\软件 将安装到 D:\软件\Forge）。"

  !macro customInstallMode
    ; 强制 per-user 并跳过「安装模式」页（multiUserUi PRE 见 $isForceCurrentInstall=="1" 即 Abort）
    StrCpy $isForceCurrentInstall "1"
  !macroend

  !macro customInstall
    ; 仅 electron-updater 更新路径同时满足（恒传 --updated --force-run）；
    ; 首装/手动重装/静默装均不进此分支，走向导原生流程（进度页 → 结束页）。
    ${if} ${isUpdated}
    ${andIf} ${isForceRun}
      ; 复刻模板 doStartApp+quitSuccess（oneClick 收尾同款）。不能直接
      ; !insertmacro doStartApp / StartApp：① 二者定义于 installSection.nsh 第 85 行，
      ; 晚于本宏的展开点（第 81 行）；② StartApp 宏内含 Var /GLOBAL startAppArgs，
      ; 模板静默收尾分支已展开过一次，二次展开报「variable already declared」。
      ; 这里内联等价逻辑：$launchLink 在第 71~75 行已备好，StdUtils 插件已由
      ; installUtil.nsh 引入；--updated 恒真（本分支前提），直接字面传参。
      HideWindow
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      !insertmacro quitSuccess
    ${endif}
  !macroend
!endif
