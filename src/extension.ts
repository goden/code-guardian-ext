import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
        stream.markdown("你好！我已經成功進化為 TypeScript 擴充套件！🎉\n\n");
        stream.markdown(`你剛才輸入的指令是：**${request.prompt}**\n\n`);
        stream.markdown("> 接下來的階段，我們將在這裡結合 API，自動分析你的程式碼結構，並產出精確的測試腳本！");
        
        return { metadata: { command: request.command } };
    };

    const participant = vscode.chat.createChatParticipant('codeguardian.expert', handler);
    participant.iconPath = new vscode.ThemeIcon('beaker');

    context.subscriptions.push(participant);
}

export function deactivate() {}