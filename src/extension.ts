import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {

        // 在 AI 回應前，先在聊天視窗顯示一個讀取中的進度條
        stream.progress("CodeGuardian 正在深度分析中...");

        try {
            // 1. 取得 Copilot 提供的語言模型
            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot'});

            if (!model) {
                stream.markdown("找不到可用的語言模型，請確認 GitHub Copilot 已正確登入並啟用。");
                return;
            }

            // 2. 建立對話上下文 (System Prompt + User Prompt)
            // 這裡我們直接賦予它自動化測試與前端/後端技術棧的專業知識
            const messages = [
                vscode.LanguageModelChatMessage.User(
                    "你是一位資深的技術負責人，精通 Clean Code 原則與自動化測試架構。你特別擅長處理 Java 搭配 JUnit 5 的後端測試，以及 Angular 搭配 Playwright 的端到端 (E2E) 測試。請用專業、嚴謹的繁體中文回答使用者的問題，如果需要，請直接給出具體的重構或測試程式碼範例。"
                ),
                vscode.LanguageModelChatMessage.User(request.prompt)
            ];           

            // 3. 發送請求給模型
            const chatResponse = await model.sendRequest(messages, {}, token);

            // 4. 將 AI 產生的結果一段一段「即時串流」回聊天視窗 (打字機效果)
            for await (const fragment of chatResponse.text) {
                stream.markdown(fragment);
            }

        } catch (error) {
            stream.markdown(`呼叫API時發生錯誤: ${error}`);
        }
    };

    const participant = vscode.chat.createChatParticipant('codeguardian.expert', handler);
    participant.iconPath = new vscode.ThemeIcon('beaker');

    context.subscriptions.push(participant);
}

export function deactivate() {}