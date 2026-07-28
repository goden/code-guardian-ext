CodeGuardian - 我的專屬 AI 測試助手

# 簡介
CodeGuardian 是一個 VSCode 擴充套件，旨在協助開發者進行程式碼測試。它利用 AI 技術，提供自動化的測試建議和生成測試案例，幫助開發者提高程式碼的可靠性和品質。

# 功能特色
- **自動生成測試案例**：根據現有程式碼，自動生成對應的測試案例，節省開發者撰寫測試的時間。
- **測試建議**：提供針對程式碼的測試建議，幫助開發者識別潛在的問題和改進點。
- **多語言支援**：目前支援 Java 和 TypeScript，未來將擴展至更多程式語言。
- **即時回饋**：在編輯程式碼的同時，提供即時的測試建議和反饋，提升開發效率。
- **整合 VSCode 環境**：無縫整合於 VSCode 開發環境，使用者可以直接在編輯器中使用 CodeGuardian 的功能。
- **自訂化設定**：使用者可以根據自己的需求，自訂 CodeGuardian 的行為和功能，提升使用體驗。
- **安全性與隱私保護**：CodeGuardian 重視使用者的程式碼安全，所有的程式碼分析和測試建議均在本地進行，確保使用者的程式碼不會被外洩。
- **持續更新與改進**：CodeGuardian 團隊持續收集使用者的反饋，定期更新和改進擴充套件，確保提供最佳的使用體驗。

# 安裝與使用
## 安裝

1. 打開 VSCode，進入擴充套件市場。
2. 搜尋 "CodeGuardian" 並安裝。

## 使用

1. 打開一個程式碼檔案。
2. 使用快捷鍵或右鍵選單啟動 CodeGuardian。
3. 根據提示生成測試案例或查看測試建議。

# 指令集
- `codeguardian.generateTestCases`: 生成測試案例。
- `codeguardian.showTestSuggestions`: 顯示測試建議。
- `codeguardian.runTests`: 執行測試。
- `codeguardian.configure`: 配置 CodeGuardian 設定。
- `codeguardian.help`: 顯示幫助資訊。
- `codeguardian.about`: 顯示關於 CodeGuardian 的資訊。
- `codeguardian.feedback`: 提交使用者反饋。

# Github Copilot Slash Commands

``` bash
# 對當前開啟的檔案進行程式碼審查，並提供改進建議。
@guardian /analyze
```

``` bash
# 重構當前檔案，檢查壞味道 (Code Smell) 並提升可讀性
@guardian /refactor
```

``` bash
# 在本地端執行本地端可執行指令
@guardian /local <command>

# 查詢 JDK 版本
@guardian /local java -version

# 查詢當前專案的 Git 狀態
@guardian /local git status

# 若未給定 command，預設執行 `mvn test`，並回傳測試結果
@guardian /local
```

``` bash
# 針對當前檔案生成單元測試案例
@guardian /test
```


