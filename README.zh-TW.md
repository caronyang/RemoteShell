# RemoteShell

Windows 桌面遠端終端機軟體，功能對標 Xshell。支援 SSH v2 與 Telnet、SFTP 檔案傳輸、跳板機，以及多語系介面（英文 / 繁體中文）。

## 功能總覽

- SSH v2 與 Telnet 連線
- 連線清單、分組、搜尋與標籤
- 單跳跳板機（bastion）支援
- SFTP 雙面板拖放傳輸與傳輸佇列（暫停/續傳/重試）
- 多終端分頁，支援 ANSI 16/256 色與 CJK/UTF-8
- 英文 / 繁體中文，切換立即生效不需重啟

## 系統需求

- Windows 10/11，64 位元
- 安裝檔約 90–130MB；不需另裝執行期

> 已在 Windows 10 22H2 驗證。Windows 11 依設計支援，但冷啟、DPAPI 憑證儲存、內嵌字型鏈三項**待使用者實機驗證（尚未 PASS）**。

## 第一次連線

1. 檔案 → 新增連線（Ctrl+Shift+N）。
2. 填入主機/埠，選擇驗證方式：帳號密碼、Password 檔案、Public key。
3. 在左側樹雙擊連線以連線。
4. 在 SSH 連線啟用時，點工具列 SFTP 按鈕（Ctrl+Shift+S）開啟雙面板傳輸。

## 跳板設定

先將跳板機存成一般連線，再於目的連線的「跳板」分頁啟用跳板並選取它。v1 僅支援單跳。SFTP 傳輸會使用同一通道。

## 金鑰格式

支援：OpenSSH 與 PEM（RSA / ECDSA / Ed25519），含帶 passphrase 的金鑰。

PuTTY `.ppk` 檔案不直接支援。請以 PuTTYgen 轉檔：Conversions → Export OpenSSH key。

## 資料位置與安全

所有資料存放於 `%APPDATA%\RemoteShell\`：

- `settings.json`
- `connections.json`
- `known_hosts.json`
- `logs\app-YYYYMMDD.log`

密碼以 Windows DPAPI 加密儲存。只有同一台電腦的同一 Windows 使用者可解密；換機或換帳號需重新輸入憑證。

## 設定

- 最大同時傳輸數（預設 3，可調 1–10）
- 下載預設資料夾
- 同名檔處理：每次詢問 / 覆寫 / 自動改名
- 下載完成後：開啟資料夾 / 通知
- 關閉視窗時若有活動連線：詢問 / 強制斷線

## 快速鍵

| 快速鍵 | 動作 |
|---|---|
| Ctrl+Q | 快速連線 |
| Ctrl+Shift+N | 新增連線 |
| Ctrl+Tab / Ctrl+1..9 | 切換分頁 |
| Ctrl+W | 關閉目前分頁 |
| Ctrl+Shift+S | 開啟 SFTP |
| Ctrl+Shift+Q | 切換傳輸佇列 |
| Ctrl+, | 設定 |
| Ctrl+Shift+L | 切換語言 |

## 疑難排解

- 連線逾時：確認網路/防火牆與主機埠。
- 主機金鑰變更警告：確認指紋，可能遭受中間人攻擊。
- 跳板失敗：查看狀態列顯示的失敗階段。
- 中文亂碼：確認遠端 shell 使用 UTF-8 locale（LANG）。
- Telnet 連線不支援 SFTP（按鈕停用）。

## 建置

```powershell
npm ci
npm run dev
npm run build
npm run dist
npm run make:setup
```

測試：`npm test`；型別檢查：`npm run typecheck`；程式碼檢查：`npm run lint`。

## 授權

- Electron、React、xterm.js、ssh2：MIT
- Cascadia Mono：SIL Open Font License 1.1 (OFL-1.1)，附授權檔
- Inno Setup：免費可商用
- Consolas：僅系統 fallback，不隨附

## 已知限制

- v1 僅支援單跳跳板。
- `.ppk` 金鑰需以 PuTTYgen 轉檔。
- Telnet 為明文傳輸，會提示警告。
- 傳輸續傳依實作的 SFTP 策略。
- 首次啟動可能需 2–4 秒（受防毒掃描影響），之後約 1 秒。
- 傳輸續傳僅支援同一檔案追加；來源變更時會重傳。