import * as vscode from 'vscode';

export class GuardianCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
const lenses: vscode.CodeLens[] = [];
        const text = document.getText();
        
        // 簡單偵測 Java 或 TypeScript 的 public 方法
        const regex = /public\s+(?:[\w<>\[\]]+\s+)?(\w+)\s*\(/g;
        let match;
        
        while ((match = regex.exec(text)) !== null) {
            const line = document.positionAt(match.index).line;
            const range = new vscode.Range(line, 0, line, 0);
            
            // 定義按鈕外觀與觸發的指令
            const command: vscode.Command = {
                title: "🤖 CodeGuardian: 生成測試",
                command: "workbench.action.chat.open", 
                arguments: [{ query: `@guardian /remote 請幫我針對 ${match[1]} 方法生成測試案例` }]
            };
            
            lenses.push(new vscode.CodeLens(range, command));
        }
        return lenses;
    }
}