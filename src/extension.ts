import * as vscode from 'vscode';

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {

        // --- 攔截 /local 指令：執行本地腳本或指令 ---
        if (request.command === 'local') {
            stream.progress("CodeGuardian 正在執行本機指令...");
            try {

                // 1. 取得當前開啟的工作區路徑，確保指令在正確的資料夾下執行
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    stream.markdown("❌ 錯誤：請先開啟一個工作區 (資料夾) 才能執行本地指令。");
                    return { metadata: { command: request.command } };
                }

                const currentWorkspacePath = workspaceFolders[0].uri.fsPath;

                // 2. 決定要執行的指令：讀取使用者的輸入，若無則預設為 git status
                // 可改成 `mvn clean test` 或是公司內部的 bash 腳本
                const commandToExecute = request.prompt.trim() || 'git status';
                stream.markdown(`> 準備於本機執行：\`${commandToExecute}\`\n\n`);

                // 3. 執行指令並等待結果
                const { stdout, stderr } = await execAsync(commandToExecute, { 
                    cwd: currentWorkspacePath // 指定執行目錄
                });

                // 4. 將執行結果回傳給使用者
                if (stdout) {
                    stream.markdown("✅ **執行成功，輸出結果：**\n");
                    stream.markdown(`\`\`\`text\n${stdout}\n\`\`\`\n`);
                }
                if (stderr) {
                    stream.markdown("⚠️ **執行過程中有錯誤輸出：**\n");
                    stream.markdown(`\`\`\`text\n${stderr}\n\`\`\`\n`);
                }

            } catch (err: any) {
                // 捕捉指令執行失敗 (例如找不到指令)
                stream.markdown(`❌ **指令執行失敗**：\n\`\`\`text\n${err.message}\n\`\`\``);
            }

            // 提早 Return，不呼叫 LLM
            return { metadata: { command: request.command } };
        }

        // ==========================================
        // 下方為先前實作的 /test 與 /refactor 呼叫 Copilot LLM 的邏輯...
        // 這裡要保留
        // ==========================================

        try {

            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                if (!model) {
                    stream.markdown("找不到可用的語言模型。");
                    return;
                }
    
                // --- 1. 取得上下文情報 ---
                const activeEditor = vscode.window.activeTextEditor;
                const activeFileContent = activeEditor ? activeEditor.document.getText() : undefined;
    
                const testFilesUris = await vscode.workspace.findFiles(
                    '**/*{Test.java,.spec.ts}', 
                    '**/node_modules/**'
                );
                
                const testFilesList = testFilesUris
                    .slice(0, 10)
                    .map(uri => vscode.workspace.asRelativePath(uri))
                    .join('\n');
    
                // --- 2. 根據Slash Command的參數，決定要執行的動作 ---
                let taskInstruction = "你的核心任務是協助開發者解答任何程式碼相關問題。";
    
                if(request.command === 'test') {
                    taskInstruction = "你的核心任務是：忽略使用者的閒聊，直接為當前提供的程式碼撰寫高品質的自動化測試。請務必包含正常路徑與邊界條件。";
                } else if (request.command === 'refactor'){
                    taskInstruction = "你的核心任務是：對當前程式碼進行深度 Code Review，指出潛在的效能瓶頸或設計瑕疵，並直接給出重構後的程式碼對比。";
                }
    
                // --- 3. 構建 System Prompt (系統指令) ---
                // 使用純字串樣板，這非常類似 Angular 中組合 HTML template 或 Java 中的字串串接
                let systemPromptString = `
    你是一位資深的技術負責人，精通 Clean Code 原則與自動化測試架構。
    ${taskInstruction}
    
    技術端規範：
    - 後端測試：優先使用 Java 搭配 JUnit 5 與 Mockito。
    - 端到端 (E2E) 測試：優先使用 Angular 搭配 Playwright。
    - 回應時請使用專業的繁體中文，並提供具體的程式碼範例。
    `;
                // 動態附加工作區資訊
                if (testFilesList) {
                    systemPromptString += `\n目前工作區內已存在的測試檔案列表（供參考命名與架構）：\n${testFilesList}\n`;
                }
    
                // --- 4. 構建 User Prompt (使用者輸入) ---
                let userPromptString = request.prompt || "請執行你的核心任務。";
                
                // 動態附加當前檔案內容
                if (activeFileContent) {
                    userPromptString = `
    我目前正在編輯的檔案內容如下：
    \`\`\`
    ${activeFileContent}
    \`\`\`
    
    使用者的補充說明：${userPromptString}
    `;
                }
    
                // --- 5. 封裝為 VS Code 訊息陣列 ---
                // VS Code LM API 不支援 System role，將 system prompt 合併至 User 訊息
                const messages = [
                    vscode.LanguageModelChatMessage.User(`${systemPromptString}\n\n${userPromptString}`)
                ];
                
                const chatResponse = await model.sendRequest(messages, {}, token);
                for await (const fragment of chatResponse.text) {
                    stream.markdown(fragment);
                }
    
            } catch (err) {
                stream.markdown(`呼叫 AI 模型時發生錯誤：${err}`);
            }

        
        return { metadata: { command: request.command } };
    };

    const participant = vscode.chat.createChatParticipant('codeguardian.expert', handler);
    participant.iconPath = new vscode.ThemeIcon('beaker');
    context.subscriptions.push(participant);
}

export function deactivate() {}
