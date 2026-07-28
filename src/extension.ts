import * as vscode from 'vscode';

import { exec } from 'child_process';
import { promisify } from 'util';

import { GuardianCodeLensProvider } from './provider/GuardianCodeLensProvider';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {

    // ==========================================
    //        無頭 Agent (背景守護行程)
    // ==========================================

    // Step 1: 建立診斷集合 (用來在編輯器畫波浪底線)
    const diagnosticsCollection = vscode.languages.createDiagnosticCollection("codeGuardian");
    context.subscriptions.push(diagnosticsCollection);

    // Step 2. 監聽檔案存檔事件
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            
            // only analyze Java and TypeScript files
            if (document.languageId !== 'java' && document.languageId !== 'typescript') {
                return;
            }

            // avoid scanning the empty file
            const text = document.getText();
            if (!text.trim()) {
                return;
            }

            // show the progress in lower right corner of VS Code, no bothering the user.
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: "CodeGuardian 正在進行背景分析..."
            }, async (progress) => {
                try {

                    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                    if (!model) return;

                    // clear the warning underline squiggle for this document
                    diagnosticsCollection.delete(document.uri);

                    // Step 3. 嚴格要求 AI 回傳 JSON 格式
                    const systemPromptString = `
你是一個極度嚴格的 Code Reviewer。
請分析以下程式碼，找出潛在的 Code Smell、效能瓶頸、或是可能發生 NullPointerException 的地方。
你必須「只」回傳一個 JSON 陣列，絕對不能有任何其他的 Markdown 文字或解說。
如果程式碼寫得很完美，請回傳空陣列 []。

JSON 格式規範如下：
[
  {
    "line": 發現問題的行號 (數字，從 0 開始計算),
    "message": "具體的重構建議或警告",
    "severity": "Warning" 或 "Error"
  }
]`;

                    const messages = [
                        vscode.LanguageModelChatMessage.User(systemPromptString),
                        vscode.LanguageModelChatMessage.User(text)
                    ];

                    const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

                    let responseText = "";
                    for await (const fragment of chatResponse.text) {
                        responseText += fragment;
                    }

                    // Step 4: 解析 AI 回傳的字串，提取 JSON 陣列
                    // 使用正規表達式把 [] 之間的內容抓出來，防止 AI 擅自加上 ```json 標籤
                    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        const issues = JSON.parse(jsonMatch[0]);
                        const diagnostics: vscode.Diagnostic[] = [];

                        issues.forEach((issue: any) => {

                            // 確保行號不為負數 (VS Code API 的行號是 index 0 開始)
                            const line = Math.max(0, issue.line);

                            // 標示範圍：從該行的第 0 個字元畫到第 100 個字元
                            const range = new vscode.Range(line, 0, line, 100);

                            let severity = vscode.DiagnosticSeverity.Warning;
                            if (issue.severity === "Error") severity = vscode.DiagnosticSeverity.Error;

                            const diagnostic = new vscode.Diagnostic(range, `[CodeGuardian 建議] ${issue.message}`, severity);
                            diagnostics.push(diagnostic);
                        });

                        // 5. 將波浪底線畫到當前檔案上！
                        diagnosticsCollection.set(document.uri, diagnostics);

                    }

                } catch (err: any) {
                    console.error("CodeGuardian 背景掃描失敗:", err);
                }
            });

        })
    );

    // ==========================================
    // 小燈泡 (Code Action) 與自動修復
    // ==========================================

    // 1. 註冊自動修復的背景指令
    context.subscriptions.push(
        vscode.commands.registerCommand('codeguardian.applyFix', async (document: vscode.TextDocument, range: vscode.Range, diagnosticMessage: string) => {
            
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "CodeGuardian: 正在自動修復程式碼...",
                cancellable: false
            }, async (progress) => {
                try {
                    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                    if (!model) return;

                    // 擴展 Range，確保我們抓到的是整行程式碼
                    const fullLineRange = new vscode.Range(range.start.line, 0, range.end.line, document.lineAt(range.end.line).text.length);
                    const originalCode = document.getText(fullLineRange);
                    const fullFileText = document.getText(); // 提供全檔作為上下文

                    // 嚴格要求 AI 只回傳修復後的程式碼片段
                    const systemPrompt = `
你是一個程式碼自動修復機器人。
使用者會提供你【整份檔案的上下文】、【有問題的那行程式碼】以及【修改建議】。
你的任務是：根據建議，寫出用來「替換該行」的正確程式碼。
⚠️ 極度重要限制：
1. 你「只能」回傳修復後的純程式碼字串。
2. 絕對不能包含 Markdown 語法 (如 \`\`\`java)。
3. 絕對不能有任何開場白或解釋。
4. 注意保持原本的縮排層級。
`;
                    const userPrompt = `
修改建議：${diagnosticMessage}
有問題的原始碼：
${originalCode}

檔案上下文參考：
${fullFileText}
`;

                    const messages = [
                        vscode.LanguageModelChatMessage.User(systemPrompt),
                        vscode.LanguageModelChatMessage.User(userPrompt)
                    ];

                    const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                    
                    let newCode = "";
                    for await (const fragment of chatResponse.text) {
                        newCode += fragment;
                    }

                    // 濾除可能的幻覺 Markdown 標籤 (防呆機制)
                    newCode = newCode.replace(/^```[a-z]*\n/gm, '').replace(/```$/gm, '').trimEnd();

                    // 執行 WorkspaceEdit，直接修改編輯器內的程式碼
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(document.uri, fullLineRange, newCode);
                    await vscode.workspace.applyEdit(edit);
                    
                    vscode.window.showInformationMessage("✅ CodeGuardian: 程式碼修復完成！");

                } catch (err) {
                    vscode.window.showErrorMessage("❌ CodeGuardian: 修復失敗，請自行查看建議。");
                }
            });
        })
    );

    // 2. 註冊 CodeActionProvider (小燈泡選單)
    class GuardianCodeActionProvider implements vscode.CodeActionProvider {
        provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
            const actions: vscode.CodeAction[] = [];

            // 檢查當前游標位置是否包含我們畫的波浪底線 (診斷訊息)
            for (const diagnostic of context.diagnostics) {
                // 確保這個警告是我們 CodeGuardian 發出的
                if (diagnostic.message.startsWith('[CodeGuardian 建議]')) {
                    
                    // 建立一個 Quick Fix 動作
                    const action = new vscode.CodeAction('🤖 請 CodeGuardian 自動修復此問題', vscode.CodeActionKind.QuickFix);
                    
                    // 將這個動作綁定到我們上面的指令，並把需要的參數傳過去
                    action.command = {
                        command: 'codeguardian.applyFix',
                        title: '套用 AI 修復',
                        arguments: [document, diagnostic.range, diagnostic.message]
                    };
                    
                    action.diagnostics = [diagnostic];
                    action.isPreferred = true; // 讓它出現在清單最上方
                    
                    actions.push(action);
                }
            }
            return actions;
        }
    }

    // 將小燈泡註冊到 Java 與 TypeScript 檔案中
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            [{ language: 'java' }, { language: 'typescript' }], 
            new GuardianCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );

    // 將 CodeLens 註冊到 Java 與 TypeScript 檔案
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            [{ language: 'java' }, { language: 'typescript' }],
            new GuardianCodeLensProvider()
        )
    );

    // 以下為指令集
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {

        // --- 攔截 /analyze 指令：讀取語法樹結構 ---
        if (request.command === 'analyze') {
            stream.progress("CodeGuardian 正在解析檔案的語法樹結構 (AST)...");
            
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    stream.markdown("❌ 錯誤：請先開啟一個 Java 或 TypeScript 檔案。");
                    return { metadata: { command: request.command } };
                }
                const document = activeEditor.document;

                // 呼叫 VS Code 內建的 Provider 來取得文件的結構樹 (AST Symbols)
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    document.uri
                );

                if (!symbols || symbols.length === 0) {
                    stream.markdown("⚠️ 無法解析此檔案的結構，請確認你的 Java/Angular 擴充套件已正確載入。");
                    return { metadata: { command: request.command } };
                }

                stream.markdown(`> 成功擷取檔案結構，正在梳理核心業務邏輯...\n\n`);

                // 遞迴解析語法樹，只提取 Class 和 Method，過濾掉變數等雜訊
                let structureInfo = "檔案結構分析結果：\n";
                
                const extractSymbols = (syms: vscode.DocumentSymbol[], indent: string = "") => {
                    for (const sym of syms) {
                        // SymbolKind.Class = 5, SymbolKind.Method = 6
                        if (sym.kind === vscode.SymbolKind.Class) {
                            structureInfo += `${indent}📦 類別: **${sym.name}**\n`;
                            extractSymbols(sym.children, indent + "  ");
                        } else if (sym.kind === vscode.SymbolKind.Method || sym.kind === vscode.SymbolKind.Function) {
                            structureInfo += `${indent}⚙️ 方法: \`${sym.name}\` (詳細簽章: ${sym.detail})\n`;
                        }
                    }
                };
                
                extractSymbols(symbols);

                // 先把我們抓到的乾淨結構印出來讓你看
                stream.markdown("### 🔍 提取出的程式結構\n");
                stream.markdown(structureInfo + "\n\n");

                // --- 接著將乾淨的結構餵給 LLM，請它規劃測試策略 ---
                stream.progress("正在交由 AI 根據結構規劃 JUnit 5 / Playwright 測試...");

                const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                if (!model) return { metadata: { command: request.command } };

                const systemPromptString = `
你是一位嚴謹的架構師。使用者會提供你一份由 AST 解析出來的「類別與方法結構清單」，而不是冗長的原始碼。
你的任務是：
1. 分析這些方法，挑選出哪些是業務邏輯 (需要寫測試)，哪些是 Getter/Setter (不一定需要測試)。
2. 針對需要測試的核心方法，列出對應的 JUnit 5 或 Playwright 測試案例 (Test Cases) 大綱。
3. 如果發現方法名稱不符合 Clean Code (例如命名含糊)，請直接提出重構建議。
`;
                const userPromptString = `這是當前檔案的結構：\n${structureInfo}`;

                const messages = [
                    vscode.LanguageModelChatMessage.User(`${systemPromptString}\n\n${userPromptString}`)
                ];

                const chatResponse = await model.sendRequest(messages, {}, token);
                stream.markdown("### 📝 測試架構規劃建議\n");
                for await (const fragment of chatResponse.text) {
                    stream.markdown(fragment);
                }

            } catch (err: any) {
                stream.markdown(`系統發生錯誤：${err.message}`);
            }
            
            return { metadata: { command: request.command } };
        }

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
                const commandToExecute = request.prompt.trim() || 'mvn clean test';
                stream.markdown(`> 準備於本機執行：\`${commandToExecute}\`\n\n`);

                let terminalOutput = "";
                try {
                    // 執行成功 (Exit Code 0)
                    const { stdout, stderr } = await execAsync(commandToExecute, { cwd: currentWorkspacePath });
                    terminalOutput = `【標準輸出 (stdout)】:\n${stdout}\n\n【標準錯誤 (stderr)】:\n${stderr}`;
                } catch (execErr: any) {
                    // 執行失敗 (Exit Code 非 0，例如編譯錯誤或測試失敗)
                    // execErr 物件中會夾帶執行失敗時的 Console Log
                    terminalOutput = `【執行異常訊息】:\n${execErr.message}\n\n【標準輸出 (stdout)】:\n${execErr.stdout}\n\n【標準錯誤 (stderr)】:\n${execErr.stderr}`;
                }

                // --- 取得終端機 Log 後，呼叫 LLM 進行深度分析 ---
                stream.progress("指令執行完畢，正在交由 AI 分析 Log 與錯誤...");

                const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                if (!model) {
                    stream.markdown("找不到可用的語言模型。");
                    return { metadata: { command: request.command } };
                }

                const systemPromptString = `
你是一位資深的 Java 技術負責人與 DevOps 專家。
你的任務是分析使用者在本地終端機執行指令後的輸出結果 (Console Log)。
- 如果執行成功，請簡短總結結果。
- 如果有錯誤（例如 Maven 建置失敗、Java 編譯錯誤、JUnit 測試未通過），請直接指出問題的根本原因 (Root Cause)，並提供修復建議或具體的程式碼修改方案。
- 請過濾掉不重要的 Log，直指核心。
`;

                const userPromptString = `
我剛才在專案根目錄執行了指令：\`${commandToExecute}\`
以下是終端機的完整輸出紀錄：
\`\`\`text
${terminalOutput}
\`\`\`
請幫我分析這個結果。
`;
                const messages = [
                    vscode.LanguageModelChatMessage.User(`${systemPromptString}\n\n${userPromptString}`)
                ];

                const chatResponse = await model.sendRequest(messages, {}, token);
                for await (const fragment of chatResponse.text) {
                    stream.markdown(fragment);
                }

            } catch (err: any) {
                stream.markdown(`系統發生錯誤：${err.message}`);
            }

            // 提早 Return，結束任務
            return { metadata: { command: request.command } };
        }

        // ==========================================
        // 下方為先前實作的 /test 與 /refactor 呼叫 Copilot LLM 的邏輯...
        // 這裡要保留
        // ==========================================
        if (request.command == 'test' || request.command == 'refactor') {
            stream.progress("CodeGuardian 正在執行明確任務...");
            
            try {
    
                const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                if (!model) {
                    stream.markdown("找不到可用的語言模型。");
                    return { metadata: { command: request.command } };
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
        }

        // --- 攔截 /remote 指令：呼叫遠端 Java 8 Agent ---
        if (request.command === 'remote') {

            stream.progress("正在連線至本地 Java 8 Agent 伺服器...");

            try {
                // 1. 取得使用者輸入的程式碼片段
                const activeEditor = vscode.window.activeTextEditor;
                const activeFileContent = activeEditor ? activeEditor.document.getText() : "";

                // 2. 呼叫本地 Java 8 Agent 伺服器 (假設它在 http://localhost:3030/analyze)
                const response = await fetch('http://localhost:3030/api/agent/stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: request.prompt || "請幫我分析這段程式碼",
                        code: activeFileContent
                    })
                });

                if (!response.ok || !response.body) {
                    stream.markdown(`❌ 連線失敗，請確認 Spring Boot 伺服器已啟動 (HTTP ${response.status})`);
                    return { metadata: { command: request.command } };
                }

                // 2. 解析 Server-Sent Events (SSE) 串流
                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";

                while (true) {

                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');

                    // 保留最後一行未完整讀取的資料在 buffer 中
                    buffer = lines.pop() || "";

                    let currentEvent = "message";

                    for (const line of lines) {
                        if (line.startsWith('event:')) {
                            currentEvent = line.replace('event:', '').trim();
                        } else if (line.startsWith('data:')) {
                            const data = line.replace('data:', '').trim();
                            
                            if (data === "[DONE]") {
                                break; // 伺服器通知結束
                            }

                            // 根據 Java 傳來的 event 類型做不同處理
                            if (currentEvent === "progress") {
                                stream.progress(data); // 更新進度條
                            } else if (currentEvent === "message") {
                                // 處理 Java 傳來的換行符號編碼 (實務上常以 \\n 傳遞)
                                const textChunk = data.replace(/\\n/g, '\n');
                                stream.markdown(textChunk); // 渲染打字機效果
                            } else if (currentEvent === "action") {
                                try {
                                    const payload = JSON.parse(data);
    
                                    if (payload.action === "create_file") {
                                        const workspaceFolders = vscode.workspace.workspaceFolders;
                                        if (workspaceFolders && workspaceFolders.length > 0) {
                                            const rootUri = workspaceFolders[0].uri;
    
                                            // 組合出新檔案的完整路徑 (直接放在工作區根目錄)
                                            const newFileUri = vscode.Uri.joinPath(rootUri, payload.filename);
    
                                            // 宣告 WorkspaceEdit
                                            const edit = new vscode.WorkspaceEdit();
    
                                            // 若檔案不存在則建立並覆寫檔案內容
                                            edit.createFile(newFileUri, { overwrite: true });
                                            edit.insert(newFileUri, new vscode.Position(0, 0), payload.content);
    
                                            // 執行寫入動作
                                            await vscode.workspace.applyEdit(edit);
    
                                            // 連帶把剛建立的檔案打開讓開發者看
                                            const doc = await vscode.workspace.openTextDocument(newFileUri);
                                            await vscode.window.showTextDocument(doc, { preview: false });
    
                                            // 在介面上彈出成功通知
                                            vscode.window.showInformationMessage(`✅ CodeGuardian: 已自動生成測試檔 ${payload.filename}`);
                                            stream.markdown(`✅ 已自動生成測試檔 \`${payload.filename}\`，並已打開編輯器。`);
    
                                        }
                                    }
                                } catch (parseErr:any) {
                                    console.error("解析 action 事件失敗:", parseErr);
                                }
                            }
                        }
                    }

                }

            } catch (err:any) {
                stream.markdown(`❌ 伺服器連線異常：${err.message}`);
            }

            return { metadata: { command: request.command } };
        }


        // ==========================================
        // 4. 最後才是：一般對話區塊 (導入 Tools API 工具調用)
        // 當 request.command 為 undefined 時，就會走到這裡
        // ==========================================
        stream.progress("CodeGuardian 正在思考解決方案...");

        try {
            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (!model) {
                stream.markdown("找不到可用的語言模型。");
                return { metadata: { command: request.command } };
            }

            // 1. 宣告 AI 可以使用的工具箱
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "需要分析專案測試覆蓋率",
                tools: [
                    // ... 放入 scan_missing_tests 工具宣告
                    {
                        name: "scan_missing_tests",
                        description: "掃描目前工作區，找出有實作邏輯但缺乏對應 JUnit 5 或 Playwright 測試檔的類別或元件。",
                        inputSchema: {
                            type: "object",
                            properties: {
                                targetLang: {
                                    type: "string",
                                    description: "要掃描的目標語言，例如 'java' 或 'typescript'"
                                }
                            },
                            required: ["targetLang"]
                        }
                    }
                ]
            };

            const systemPrompt = `你是一位資深的架構師。請根據使用者的問題，判斷是否需要呼叫工具。如果使用者詢問測試狀態，請大膽呼叫 'scan_missing_tests' 工具來獲取實際數據，然後再以繁體中文回答。`;

            // 由於 Tools API 會有「多次往返 (Multi-turn)」的特性，我們使用陣列來維護對話歷史
            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
                vscode.LanguageModelChatMessage.User(request.prompt || "請協助我分析專案的測試覆蓋率。")
            ];

            // 2. 發送第一次請求，讓 AI 決定是否要使用工具
            const response = await model.sendRequest(messages, options, token);

            // 3. 解析 AI 的回應串流
            for await (const part of response.stream) {
                // 如果 AI 只是單純練瘋話 (TextPart)，就直接印出來
                if (part instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    
                    // 如果 AI 回傳的是工具呼叫 (ToolCallPart)，就解析工具名稱與參數
                    stream.progress(`AI 正在自動呼叫工具：${part.name}...`);
                    
                    if (part.name === "scan_missing_tests") {
                        
                        // 解析 AI 傳進來的參數
                        const args = part.input as { targetLang: string };
                        let scanResult = "";

                        // 4.執行實地的本地邏輯(模擬檔案掃描)
                        // 實務上呼叫 vscode.workspace.findFiles 進行真正的比對
                        if (args.targetLang.toLowerCase() === 'java') {
                            
                            try {
                                // 步驟 A: 找出所有的 Java 測試檔 (排除 node_modules 或 target 等編譯資料夾)
                                const testFiles = await vscode.workspace.findFiles('**/*Test.java', '**/{node_modules,target,.git}/**');

                                // 建立一個 Set，存放已經有測試檔的類別名稱 (例如 "UserServiceTest.java" -> "UserService")
                                const testFileBaseNames = new Set(testFiles.map(uri => {
                                    const fileName = uri.path.split('/').pop() || '';
                                    return fileName.replace('Test.java', '');
                                }));

                                // 步驟 B: 找出所有的 Java 來源檔 (這裡簡單以排除 Test.java 來過濾)
                                const sourceFiles = await vscode.workspace.findFiles('**/*.java', '**/*Test.java');

                                const missingTests: string[] = [];

                                // 步驟 C: 比對哪些來源檔沒有在 Set 裡面
                                for (const uri of sourceFiles) {
                                    const fileName = uri.path.split('/').pop() || '';
                                    const baseName = fileName.replace('.java', '');
                                    
                                    // 實務上可以進一步略過 DTO, Entity 等不一定需要單元測試的檔案
                                    if (!testFileBaseNames.has(baseName)) {
                                        missingTests.push(fileName);
                                    }
                                }

                                // 步驟 D: 組合給 AI 的結果報告
                                if (missingTests.length === 0) {
                                    scanResult = "掃描結果：Workspace內所有的 Java 檔都有對應的單位測試檔。";
                                } else {
                                    // 為了避免 Token 爆炸，我們最多只把前 5 個沒寫測試的檔案名稱餵給 AI
                                    const topMissing = missingTests.slice(0, 5);
                                    scanResult = `掃描結果：共發現 ${missingTests.length} 個 Java 檔案缺乏對應的測試檔。例如以下這些檔案需要優先處理：${topMissing.join(', ')}。`;
                                }

                            } catch (err) {
                                scanResult = "掃描過程中發生錯誤，請確認工作區是否有 Java 專案。";
                            }
                        } else if (args.targetLang.toLowerCase() === 'typescript' || args.targetLang.toLowerCase() === 'angular') {
                            
                            // TypeScript 的掃描邏輯同理，比對 .ts 與 .spec.ts
                            try {
                                
                                // 步驟 A: 找出所有的 TypeScript 測試檔 (排除 node_modules 或 dist 等資料夾)
                                const tsTestFiles = await vscode.workspace.findFiles('**/*.spec.ts', '**/{node_modules,dist,out,.git}/**');

                                // 建立 Set 存放基底名稱 (例如 "login.component.spec.ts" -> "login.component")
                                const tsTestFileBaseNames = new Set(tsTestFiles.map(uri => {
                                    const fileName = uri.path.split('/').pop() || '';
                                    return fileName.replace('.spec.ts', '');
                                }));

                                // 步驟 B: 找出所有的 TypeScript 來源檔 (排除 .spec.ts 以過濾出純原始碼)
                                const tsSourceFiles = await vscode.workspace.findFiles('**/*.ts', '**/{node_modules,dist,out,.git,*.spec.ts}/**');

                                const tsMissingTests: string[] = [];

                                // 步驟 C: 比對哪些來源檔沒有在 Set 裡面
                                for (const uri of tsSourceFiles) {
                                    const fileName = uri.path.split('/').pop() || '';
                                    const baseName = fileName.replace('.ts', '');
                                    
                                    // 針對 Angular 專案的實務優化：略過 module 定義檔與環境變數檔
                                    if (!fileName.endsWith('.module.ts') && !fileName.includes('environment')) {
                                        if (!tsTestFileBaseNames.has(baseName)) {
                                            tsMissingTests.push(fileName);
                                        }
                                    }
                                }
                                
                                // 步驟 D: 組合給 AI 的結果報告
                                if (tsMissingTests.length === 0) {
                                    scanResult = "掃描結果：工作區內所有的 TypeScript/Angular 檔案都有對應的 .spec.ts 測試檔。";
                                } else {
                                    // 同樣採用防爆機制，只回傳前 5 個給 AI 進行 Playwright/Jasmine 測試規劃
                                    const topMissing = tsMissingTests.slice(0, 5);
                                    scanResult = `掃描結果：共發現 ${tsMissingTests.length} 個 TypeScript 檔案缺乏對應的測試檔。例如以下這些檔案需要優先處理：${topMissing.join(', ')}。`;
                                }

                            } catch (err:any) {
                                scanResult = "掃描 TypeScript 工作區時發生錯誤。";
                            }

                        } else {
                            scanResult = "目前僅支援 Java 與 TypeScript 的掃描。";
                        }

                        // 5. 將工具執行的結果「加回對話歷史中」，發送第二次請求給 AI
                        messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [part]));
                        messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                            new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(scanResult)])
                        ]));

                        stream.progress(`工具執行完畢，正在總結報告...`);

                        // 再次呼叫模型，這次模型會根據工具回傳的數據生成最終答案
                        const finalResponse = await model.sendRequest(messages, options, token);
                        for await (const finalPart of finalResponse.stream) {
                            if (finalPart instanceof vscode.LanguageModelTextPart) {
                                stream.markdown(finalPart.value);
                            }
                        }
                    }
                }
            }

        } catch (err:any) {
            stream.markdown(`呼叫 AI 模型時發生錯誤：${err}`);
        }

        return { metadata: { command: request.command } };

    };

    const participant = vscode.chat.createChatParticipant('codeguardian.expert', handler);
    participant.iconPath = new vscode.ThemeIcon('beaker');
    context.subscriptions.push(participant);
}

export function deactivate() {}
