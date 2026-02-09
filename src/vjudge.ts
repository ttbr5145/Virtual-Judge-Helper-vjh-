declare var document: any;
declare var window: any;
import * as vscode from 'vscode';
import * as path from 'path';
import VJudgeAPI, { Contest, ContestDetail, Problem, Solution } from '@starcatmeow/vjudge-api';

// 接口定义：错误对象可能包含的属性
interface ErrorObject {
    message?: string;
    name?: string;
    stack?: string;
    response?: {
        status?: number;
        data?: any;
        headers?: any;
    };
    error?: string;
    captcha?: boolean;
}

export class VJudge {
    private api: VJudgeAPI;
    public userId?: number;
    private username?: string;
    private password?: string;
    public loggedin: boolean;
    public infoProvider: VJudgeInfoProvider;
    private axiosError?: any;
    private captchaValue?: string;
    constructor(){
        this.infoProvider = new VJudgeInfoProvider(this);
        this.loggedin = false;
        this.api = new VJudgeAPI();
    }
    login = async () => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Logging in...",
            cancellable: false
        }, async (progress) => {
            console.log('[VJudge] Login started');
            progress.report({ increment: 0 });
            if(!this.username){
                this.username = await vscode.window.showInputBox({ placeHolder: 'VJudge Username' });
                if(!this.username){
                    vscode.window.showErrorMessage('Please type username!');
                    return Promise.resolve();
                }
            }
            if(!this.password){
                this.password = await vscode.window.showInputBox({ placeHolder: 'VJudge Password' });
                if(!this.password){
                    vscode.window.showErrorMessage('Please type password!');
                    return Promise.resolve();
                }
            }
            progress.report({ increment: 50 });
            try{
                console.log('[VJudge] Calling API login with username:', this.username);
                await this.api.login(this.username, this.password);
            }catch(e){
                console.error('[VJudge] Login failed:', e);
                vscode.window.showErrorMessage(<string>e);
                this.username = undefined;
                this.password = undefined;
                return;
            }
            progress.report({ increment: 50 });
            vscode.window.showInformationMessage(`Logged in as ${this.username}!`);
            this.loggedin = true;
            console.log('[VJudge] Login successful, attempting to fetch userId');
            // 尝试获取 userId
            this.userId = await this.fetchUserId();
            console.log('[VJudge] Retrieved userId:', this.userId);
            this.infoProvider.register();
            console.log('[VJudge] Info provider registered');
            return Promise.resolve();
        });
    };
    fetchContestList = async (): Promise<Contest[]> => {
        return this.api.listMyContest();
    };
    fetchContestProblems = async (contestId: number): Promise<Problem[]> => {
        return (await this.api.getContestDetail(contestId)).problems;
    };
    openProblemDescription = async (descriptionId: number, descriptionVersion: number, title: string) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Fetching Problem Description...',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0 });
            const html = await this.api.getProblemDescription(descriptionId, descriptionVersion);
            progress.report({ increment: 50 });
            const panel = vscode.window.createWebviewPanel('vjudge',
                title,
                vscode.ViewColumn.Two,
                {
                    enableScripts: true
                });
            panel.webview.html = html;
            progress.report({ increment: 50 });
            return Promise.resolve();
        });
    };
    submitCode = async (contestId: number, problemNum: string, code: string, language: string) => {
        console.log('[VJudge] submitCode called with params:', { contestId, problemNum, language, codeLength: code.length });
        let succeed = false;
        let runId = 0;

        // 处理验证码的重试逻辑
        const handleCaptcha = async (): Promise<boolean> => {
            console.log('[VJudge] Entering captcha handling...');
            try {
                // 获取验证码图片 - 尝试不同的 URL 格式
                const timestamp = Date.now();
                const captchaUrls = [
                    `https://vjudge.net/util/captcha?${timestamp}`,
                    `https://vjudge.net/util/captcha.png?${timestamp}`,
                    `https://vjudge.net/util/captcha.jpg?${timestamp}`,
                    `https://vjudge.net/captcha?${timestamp}`
                ];
                
                let captchaImage: string | undefined;
                let captchaUrlUsed: string | undefined;
                
                for (const url of captchaUrls) {
                    try {
                        console.log('[VJudge] Trying captcha URL:', url);
                        const response = await this.api.client.get(url, {
                            responseType: 'arraybuffer'
                        });
                        console.log('[VJudge] Captcha response status:', response.status);
                        console.log('[VJudge] Captcha response content-type:', response.headers['content-type']);
                        
                        // 检查是否是图片
                        const contentType = response.headers['content-type'] || '';
                        if (contentType.startsWith('image/')) {
                            // 将图片转换为base64
                            const data = response.data as any;
                            if (typeof data === 'string') {
                                captchaImage = Buffer.from(data, 'binary').toString('base64');
                            } else if (Buffer.isBuffer(data)) {
                                captchaImage = data.toString('base64');
                            } else {
                                captchaImage = Buffer.from(data).toString('base64');
                            }
                            captchaUrlUsed = url;
                            console.log('[VJudge] Captcha image obtained from:', url, 'size:', captchaImage.length);
                            break;
                        } else {
                            console.log('[VJudge] URL returned non-image content:', contentType);
                        }
                    } catch (e) {
                        console.log('[VJudge] URL failed:', url, 'error:', (e as Error).message);
                    }
                }
                
                if (!captchaImage) {
                    throw new Error('Unable to fetch captcha image from any URL');
                }

                // 创建webview显示验证码
                const panel = vscode.window.createWebviewPanel(
                    'vjudge-captcha',
                    'VJudge Captcha',
                    vscode.ViewColumn.Active,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true
                    }
                );

                // 生成HTML显示验证码
                const captchaHtml = `
                    <!DOCTYPE html>
                    <html lang="zh-CN">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>VJudge Captcha</title>
                        <style>
                            body {
                                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                                padding: 20px;
                                background-color: var(--vscode-editor-background);
                                color: var(--vscode-editor-foreground);
                            }
                            .container {
                                max-width: 400px;
                                margin: 0 auto;
                                text-align: center;
                            }
                            .captcha-image {
                                background-color: white;
                                border: 1px solid #ccc;
                                border-radius: 4px;
                                padding: 10px;
                                margin: 20px 0;
                                display: inline-block;
                            }
                            .captcha-image img {
                                display: block;
                                max-width: 100%;
                                height: auto;
                            }
                            .input-group {
                                margin: 20px 0;
                            }
                            .input-group input {
                                width: 100%;
                                padding: 10px;
                                font-size: 16px;
                                border: 1px solid #ccc;
                                border-radius: 4px;
                                box-sizing: border-box;
                                background-color: var(--vscode-editor-background);
                                color: var(--vscode-editor-foreground);
                            }
                            .instructions {
                                font-size: 14px;
                                color: var(--vscode-editor-foreground);
                                margin-bottom: 20px;
                            }
                            .status {
                                margin-top: 10px;
                                padding: 10px;
                                border-radius: 4px;
                                font-size: 14px;
                            }
                            .status.error {
                                background-color: #f44336;
                                color: white;
                            }
                            .status.success {
                                background-color: #4caf50;
                                color: white;
                            }
                            .status.info {
                                background-color: #2196f3;
                                color: white;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <h2>请输入验证码</h2>
                            <p class="instructions">请输入下方的验证码以继续提交</p>
                            <div class="captcha-image">
                                <img src="data:image/jpeg;base64,${captchaImage}" alt="Captcha"/>
                            </div>
                            <div class="input-group">
                                <input type="text" id="captchaInput" placeholder="输入验证码" autocomplete="off"/>
                            </div>
                            <div id="status" class="status info">准备提交...</div>
                        </div>
                        <script>
                            const vscode = acquireVsCodeApi();
                            const input = document.getElementById('captchaInput');
                            const status = document.getElementById('status');

                            input.addEventListener('keypress', (e) => {
                                if (e.key === 'Enter') {
                                    submitCaptcha();
                                }
                            });

                            function submitCaptcha() {
                                const captchaValue = input.value.trim();
                                if (!captchaValue) {
                                    showStatus('请输入验证码', 'error');
                                    return;
                                }
                                showStatus('正在提交...', 'info');
                                vscode.postMessage({
                                    type: 'submit',
                                    captcha: captchaValue
                                }, '*');
                            }

                            function showStatus(message, type) {
                                status.textContent = message;
                                status.className = 'status ' + type;
                            }

                            // 自动聚焦到输入框
                            input.focus();

                            // 监听来自扩展的消息
                            window.addEventListener('message', event => {
                                const message = event.data;
                                if (message.type === 'error') {
                                    showStatus(message.error || '提交失败', 'error');
                                } else if (message.type === 'success') {
                                    showStatus('提交成功！', 'success');
                                    setTimeout(() => {
                                        vscode.postMessage({ type: 'close' }, '*');
                                    }, 1000);
                                }
                            });
                        </script>
                    </body>
                    </html>
                `;

                panel.webview.html = captchaHtml;

                // 返回一个Promise，等待用户输入验证码
                return new Promise<boolean>((resolve) => {
                    let captchaValue = '';

                    // 监听来自webview的消息
                    const messageListener = panel.webview.onDidReceiveMessage(
                        message => {
                            console.log('[VJudge] Received message from webview:', message);
                            if (message.type === 'submit') {
                                captchaValue = message.captcha;
                                console.log('[VJudge] Captcha value received:', captchaValue);
                            } else if (message.type === 'close') {
                                panel.dispose();
                            }
                        }
                    );

                    // 监听webview关闭事件
                    const disposable = panel.onDidDispose(() => {
                        messageListener.dispose();
                        console.log('[VJudge] Captcha panel closed, captcha value:', captchaValue);
                        // 尝试使用验证码重新提交
                        if (captchaValue) {
                            resolve(true); // 用户输入了验证码
                        } else {
                            resolve(false); // 用户关闭了面板
                        }
                    });

                    // 保存captchaValue以便后续使用
                    this.captchaValue = captchaValue;
                });

            } catch (error) {
                console.error('[VJudge] Failed to handle captcha:', error);
                vscode.window.showErrorMessage('Failed to get captcha image. Please try again.');
                return false;
            }
        };

        // 尝试提交，最多重试一次（带验证码）
        const trySubmit = async (captcha?: string): Promise<{ success: boolean; error?: ErrorObject }> => {
            console.log('[VJudge] Attempting to submit, captcha provided:', !!captcha);
            try {
                console.log('[VJudge] Calling API submitCode...');
                runId = await this.api.submitCode(contestId, problemNum, code, language, captcha);
                console.log('[VJudge] submitCode succeeded, runId:', runId);
                return { success: true };
            } catch (e) {
                console.error('[VJudge] submitCode failed:', e);

                let errorMessage = 'Submission failed';
                const errorObj = e as ErrorObject;
                if (errorObj) {
                    if (errorObj.response && errorObj.response.status === 400) {
                        // 检查是否是axios HTTP 400错误
                        console.log('[VJudge] HTTP 400 error detected');
                        if (errorObj.response.data) {
                            console.log('[VJudge] Response data:', errorObj.response.data);
                            // 尝试从响应数据中提取错误信息
                            const responseData = errorObj.response.data;
                            if (typeof responseData === 'string') {
                                // 检查是否包含验证码页面特征
                                if (responseData.includes('卧槽') || responseData.includes('captcha') || responseData.includes('Captcha')) {
                                    console.log('[VJudge] Captcha required');
                                    errorMessage = 'Captcha required. Please check the captcha panel.';
                                } else {
                                    try {
                                        const parsedData = JSON.parse(responseData);
                                        if (parsedData.error) {
                                            errorMessage = parsedData.error;
                                        }
                                    } catch (parseError) {
                                        errorMessage = responseData.substring(0, 200) + '...';
                                    }
                                }
                            } else if (responseData.error) {
                                errorMessage = responseData.error;
                            }
                        } else {
                            errorMessage = 'HTTP 400 Bad Request - The server rejected the submission. This could be due to captcha requirements, invalid parameters, or contest restrictions.';
                        }
                    } else if (errorObj.error) {
                        errorMessage = errorObj.error;
                    }

                    if (errorObj.captcha) {
                        errorMessage += ' (Captcha required)';
                    }
                    vscode.window.showErrorMessage(errorMessage);
                } else {
                    vscode.window.showErrorMessage(String(e));
                }
                return { success: false, error: errorObj };
            }
        };

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Submitting Code...',
            cancellable: true
        }, async (progress, token) => {
            progress.report({ increment: 30 });

            // 第一次尝试（无验证码）
            let firstResult = await trySubmit();
            let success = firstResult.success;
            let errorObj = firstResult.error;
            console.log('[VJudge] First attempt result:', success);

            // 如果失败且需要验证码
            if (!success && errorObj) {
                if (errorObj.response && errorObj.response.data) {
                    const responseData = errorObj.response.data;
                    if (typeof responseData === 'string') {
                        if (responseData.includes('卧槽') || responseData.includes('captcha') || responseData.includes('Captcha')) {
                            console.log('[VJudge] Captcha detected, opening captcha panel');
                            progress.report({ message: 'Captcha required...' });

                            // 等待用户输入验证码
                            console.log('[VJudge] Calling handleCaptcha function...');
                            const captchaProvided = await handleCaptcha();
                            console.log('[VJudge] Captcha provided:', captchaProvided);
                            console.log('[VJudge] Captcha value:', this.captchaValue);

                            if (captchaProvided && this.captchaValue) {
                                // 第二次尝试（带验证码）
                                progress.report({ message: 'Retrying with captcha...' });
                                console.log('[VJudge] Retrying submission with captcha...');
                                const secondResult = await trySubmit(this.captchaValue);
                                success = secondResult.success;
                                console.log('[VJudge] Second attempt result:', success);
                            } else {
                                console.log('[VJudge] Captcha not provided or empty');
                            }
                        }
                    }
                }
            }

            if (!success) {
                console.log('[VJudge] submitCode failed, returning');
                return;
            }

            progress.report({ increment: 70 });
            succeed = true;
            console.log('[VJudge] submitCode progress completed, succeed=', succeed);
            return Promise.resolve();
        });
        console.log('[VJudge] submitCode first stage completed, succeed=', succeed, 'runId=', runId);
        if(!succeed){
            console.log('[VJudge] submitCode failed in first stage, returning');
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Judge',
            cancellable: false
        }, async (progress) => {
            console.log('[VJudge] Starting judgment polling for runId:', runId);
            let solution: Partial<Solution> = {
                status: 'Pending'
            };
            console.log('[VJudge] Initial solution state:', solution);
            while(true){
                progress.report({ message: solution.status });
                const result = await this.api.fetchSolution(runId);
                solution = result;
                if(!solution.processing){
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            // 如果还没有userId，尝试从solution中获取
            if (!this.userId && solution.authorId) {
                console.log('[VJudge] Setting userId from solution.authorId:', solution.authorId);
                this.userId = solution.authorId;
            }
            
            console.log('[VJudge] Final solution:', solution);
            console.log('[VJudge] Current userId:', this.userId);
            
            if(solution.statusType === 1){
                if(solution.additionalInfo){
                    vscode.window.showErrorMessage(solution.status!, 'Show additional info').then(selection => {
                        if (selection === 'Show additional info'){
                            const panel = vscode.window.createWebviewPanel('vjudge',
                                `Submission ${runId} additional info`,
                                vscode.ViewColumn.Two);
                            panel.webview.html = solution.additionalInfo!;
                        }
                    });
                }else{
                    vscode.window.showErrorMessage(solution.status!);
                }
            }else{
                vscode.window.showInformationMessage(solution.status!);
            }
            return Promise.resolve();
        });
        //Wait for VJudge to update submission status
        setTimeout(() => {
            this.infoProvider.refresh();
        }, 15000);
    };
    fetchSubmissions = async (contestId: number) => {
        return this.api.fetchSubmissions(contestId);
    };
    private fetchUserId = async (): Promise<number | undefined> => {
        try {
            console.log('[VJudge] fetchUserId: Attempting to list contests');
            const contests = await this.api.listMyContest();
            console.log('[VJudge] fetchUserId: Found contests:', contests.length);
            // 打印前10个比赛的详细信息
            for (let i = 0; i < Math.min(contests.length, 10); i++) {
                const contest = contests[i];
                console.log(`[VJudge] fetchUserId: Contest ${i}: id=${contest.id}, title="${contest.title}", openness=${contest.openness}, manager=${contest.managerName}`);
            }
            
            if (contests.length === 0) {
                console.log('[VJudge] fetchUserId: No contests found');
                return undefined;
            }
            
            // 尝试所有比赛，直到找到有提交记录的比赛
            for (const contest of contests) {
                console.log('[VJudge] fetchUserId: Trying contest', contest.id, 'title:', contest.title);
                
                try {
                    const submissions = await this.api.fetchSubmissions(contest.id);
                    console.log('[VJudge] fetchUserId: Found submissions:', submissions.length, 'for contest', contest.id);
                    
                    if (submissions.length > 0) {
                        // 显示前几个提交的submitterId，用于调试
                        console.log('[VJudge] fetchUserId: First few submission submitterIds:', 
                            submissions.slice(0, 5).map(s => s.submitterId));
                        
                        // 假设第一个提交的 submitterId 是当前用户
                        const userId = submissions[0].submitterId;
                        console.log('[VJudge] fetchUserId: Selected userId:', userId, 'from contest', contest.id);
                        return userId;
                    } else {
                        console.log('[VJudge] fetchUserId: No submissions in this contest');
                    }
                } catch (error) {
                    console.warn('[VJudge] fetchUserId: Failed to fetch submissions for contest', contest.id, error);
                    continue;
                }
            }
            
            console.log('[VJudge] fetchUserId: No submissions found in any contest');
            console.log('[VJudge] fetchUserId: User may need to make a submission first to get userId');
            
            // 如果没有任何比赛的提交记录，尝试获取用户个人资料信息
            console.log('[VJudge] fetchUserId: Trying to get userId from profile');
            const profileUserId = await this.tryGetUserIdFromProfile();
            if (profileUserId !== undefined) {
                console.log('[VJudge] fetchUserId: Got userId from profile:', profileUserId);
                return profileUserId;
            }
            console.log('[VJudge] fetchUserId: Could not get userId from profile');
            return undefined;
        } catch (error) {
            console.error('[VJudge] fetchUserId: Failed to fetch userId:', error);
            return undefined;
        }
    };

    private tryGetUserIdFromProfile = async (): Promise<number | undefined> => {
        if (!this.username) {
            console.log('[VJudge] tryGetUserIdFromProfile: No username available');
            return undefined;
        }
        try {
            console.log('[VJudge] tryGetUserIdFromProfile: Attempting to fetch profile for username:', this.username);
            // 尝试使用API client直接访问用户个人资料页面
            // 注意：这依赖于内部API，可能会随VJudge网站变化
            const response = await this.api.client.get(`https://vjudge.net/user/data/${this.username}`);
            const data = response.data;
            console.log('[VJudge] tryGetUserIdFromProfile: Response data:', data);
            if (data) {
                const anyData = data as any;
                const possibleId = anyData.id || anyData.userId || anyData.user_id;
                if (possibleId !== undefined) {
                    console.log('[VJudge] tryGetUserIdFromProfile: Found userId:', possibleId);
                    return possibleId;
                }
            }
        } catch (error) {
            console.warn('[VJudge] tryGetUserIdFromProfile: Failed to fetch user profile:', error);
        }
        return undefined;
    };
}
class VJudgeInfoProvider implements vscode.TreeDataProvider<VJudgeInfoNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<any> = new vscode.EventEmitter<any>();
	private registered: boolean;
    readonly onDidChangeTreeData: vscode.Event<any> = this._onDidChangeTreeData.event;
    data: {
        contestRootNode: VJudgeInfoNode,
        contests: Contest[],
        contestsNodeCache: Map<number, VJudgeInfoNode>
    };
    vjudge: VJudge;
    constructor(vjudge: VJudge){
        this.registered = false;
        this.data = {
            contestRootNode: new VJudgeInfoNode('Contests', vscode.TreeItemCollapsibleState.Expanded),
            contests: [],
            contestsNodeCache: new Map()
        };
        this.vjudge = vjudge;
    }
    register(){
        if(this.registered){
            return;
        }
        vscode.window.registerTreeDataProvider('vjudgeinfo', this);
        vscode.window.createTreeView('vjudgeinfo', {
            treeDataProvider: this
        });
        this.registered = true;
    }
    refresh(){
        this.data.contests = [];
        this.data.contestsNodeCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }
    getTreeItem(element: VJudgeInfoNode): vscode.TreeItem {
        return element;
    }
    async getChildren(element?: VJudgeInfoNode): Promise<VJudgeInfoNode[]> {
        // Root Node
        if(!element){
            return Promise.resolve([this.data.contestRootNode]);
        }

        // Contest Root Node
        if(element === this.data.contestRootNode){
            if(this.data.contests.length === 0 && this.vjudge.loggedin){
                this.data.contests = await this.vjudge.fetchContestList();
                for(const contest of this.data.contests){
                    // contest: 0->id 1->title 
                    if(!this.data.contestsNodeCache.get(contest.id)){
                        const infoNode = new VJudgeInfoNode(
                            contest.title.trim(),
                            vscode.TreeItemCollapsibleState.Collapsed,
                        );
                        infoNode.contest = contest;
                        infoNode.tooltip = 
                        `Start Time: ${contest.begin.toLocaleString()}
End Time: ${contest.end.toLocaleString()}
Owner: ${contest.managerName}`;
                        this.data.contestsNodeCache.set(contest.id, infoNode);
                    }
                }
            }
            let contestsNodeList = [];
            for(const contest of this.data.contestsNodeCache.values()){
                contestsNodeList.push(contest);
            }
            return Promise.resolve(contestsNodeList);
        }

        // Contest Node
        console.log('[VJudge] getChildren: Fetching problems for contest', element.contest!.id);
        const problems = await this.vjudge.fetchContestProblems(element.contest!.id);
        console.log('[VJudge] getChildren: Found problems:', problems.length);
        
        console.log('[VJudge] getChildren: Fetching submissions for contest', element.contest!.id);
        const submissions = await this.vjudge.fetchSubmissions(element.contest!.id);
        console.log('[VJudge] getChildren: Total submissions:', submissions.length);
        console.log('[VJudge] getChildren: Current userId:', this.vjudge.userId);
        
        const filteredSubmissions = submissions.filter(submission => submission.submitterId === this.vjudge.userId);
        console.log('[VJudge] getChildren: Filtered submissions (current user):', filteredSubmissions.length);
        let problemsNodeList = [];
        let i=0;
        for (const problem of problems) {
            const problemNode = new VJudgeInfoNode(
                `#${problem.num}. ${problem.title}`,
                vscode.TreeItemCollapsibleState.None
            );
            problemNode.problem = problem;
            problemNode.contest = element.contest;
            problemNode.tooltip = `From: ${problem.oj} - ${problem.probNum}`;
            problemNode.description = '';
            for (const property of problem.properties) {
                problemNode.tooltip += `\n${property.title}: ${property.content}`;
                problemNode.description += ` ${property.title}: ${property.content}`;
            }
            problemNode.command = {
                command: 'vjudge-helper.openProblemDescription',
                title: 'Open Problem Description',
                arguments: [problemNode]
            };
            problemNode.contextValue = 'problem';
            let solved = -1;
            filteredSubmissions.forEach(submission => {
                if(submission.problemIndex === i){
                    console.log(`[VJudge] Problem ${i} (${problem.num}): found submission, accepted=${submission.accepted}`);
                    solved = Math.max(solved,submission.accepted);
                }
            });
            console.log(`[VJudge] Problem ${i} (${problem.num}): final solved value=${solved}`);
            let color;
            switch(solved){
                case -1:
                    color = 'grey';break;
                case 0:
                    color = 'red';break;
                default:
                    color = 'green';
            }
            problemNode.iconPath = path.join(__filename, '..', '..', 'resources', `${color}.svg`);
            problemsNodeList.push(problemNode);
            i++;
        }
        return Promise.resolve(problemsNodeList);
    }
}
export class VJudgeInfoNode extends vscode.TreeItem{
    contest?: Contest;
    contestDetail?: ContestDetail;
    problem?: Problem;
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    ){
        super(label, collapsibleState);
    }
}
