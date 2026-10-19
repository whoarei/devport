// Manual fixture: npm run dev -> /tests/run-console-browser.html. No real processes/devices.
import React from "react";
import {createRoot} from "react-dom/client";
import {api,localWorkspace,type RunEvent,type RunStatus,type WorkspaceCommands,type WorkspaceRunSession} from "../src/api";
import {useAppStore} from "../src/store";
import {useWorkspaceRunStore} from "../src/workspaceRunStore";
import {WorkspacePanel} from "../src/components/WorkspacePanel";
import {RunToolbar} from "../src/components/RunToolbar";
import {WorkspaceRunDialogs} from "../src/components/WorkspaceRunDialogs";
import {rootTree} from "../src/workspaceTree";
import i18n from "../src/i18n";
import "../src/styles.css";

await i18n.changeLanguage("zh");
const workspace=localWorkspace("E:\\projects\\example"), sessions=new Map<string,WorkspaceRunSession>();
const statuses = new Map<string,RunStatus>();
let environmentReady = false;
function emit(events: RunEvent[]) { useAppStore.getState().handleRunEvents(events); useWorkspaceRunStore.getState().events(events); }
let config={config:{schema:1 as const,run_defaults:{cwd:"."}},revision:"missing"};
let commands:WorkspaceCommands={revision:"demo",entries:[{id:"46b30296bf66927a082124c9f71b76c2f05ab988fdb66c24efb4b3c422ca3902",entry:{type:"python_script",path:"tools/train.py"},args:["--epochs","10","--name","trial one"],last_used_at:new Date().toISOString()}]};
const tree:Record<string,{name:string;is_dir:boolean}[]>={"": [{name:"tools",is_dir:true},{name:"app",is_dir:true},{name:"run.sh",is_dir:false}],tools:[{name:"train.py",is_dir:false}],app:[{name:"__main__.py",is_dir:false}]};
api.listWorkspaceDir=async (_w,path)=>tree[path]??[];
api.readRunnerConfig=async()=>config;
api.saveRunnerConfig=async(_w,c)=>config={config:c,revision:crypto.randomUUID()};
api.listWorkspaceCommands=async()=>commands;
api.deleteWorkspaceCommand=async(_w,id)=>commands={revision:crypto.randomUUID(),entries:commands.entries.filter((r)=>r.id!==id)};
api.editWorkspaceCommandEntry=async(_w,id,entry)=>commands={revision:crypto.randomUUID(),entries:commands.entries.map((r)=>r.id===id?{...r,entry}:r)};
api.inspectWorkspacePython=async(_w,project)=>({python_version:"3.12.9",python_path:["src"],project:project?{name:"example",requires_python:">=3.12",python_version:"3.12.9",lock_sha256:"a".repeat(64),entry:"__runner_inspect__",mode:"module",python_path:["src"],groups:[],extras:[],package_source_identity:"b".repeat(64)}:null,legacy_entry:null,legacy_module:false});
api.listProjectEnvironments=async()=>environmentReady ? [{id:"demo-env",path:"C:\\runtime\\envs\\demo-env",ready:true,leased:false,manifest:{schema:1,environment_id:"demo-env",uv_version:"0.12.13",python_request:"3.12.9",python_executable:"C:\\runtime\\envs\\demo-env\\Scripts\\python.exe",python_version:"3.12.9",python_build:"demo",platform:"windows-x86_64",libc:null,lock_sha256:"a".repeat(64),groups:[],extras:[],created_at:"",last_used_at:""}}] : [];
api.listLocalShells=async()=>[{id:"gitbash",label:"Git Bash",path:"C:\\Program Files\\Git\\bin\\bash.exe"}];
api.probePythonEnvironment=async()=>({program:"C:\\Python312\\python.exe",version:"3.12.9",env:{}});
api.runnerLockInfo=async()=>null;
api.getWorkspaceRun=async(id)=>sessions.get(id)??null;
api.runWorkspace=async(request)=>{
  const id=crypto.randomUUID();sessions.set(id,{request,warning:null,launch:{program:request.command.entry.type==="bash_script"?"C:\\Program Files\\Git\\bin\\bash.exe":"C:\\Python312\\python.exe",version:request.command.entry.type==="bash_script"?null:"3.12.9",cwd:"E:\\projects\\example",python_path:[],environment:request.command.entry.type==="bash_script"?"bash":request.python}});
  if (request.operation && request.operation !== "run") {
    const status:RunStatus={run_id:id,device_name:"本机 PowerShell",label:"Prepare project Python",state:"preparing",phase:"installing_python",exit_code:null,error:null,started_at:"",ended_at:null};
    statuses.set(id,status); emit([{type:"status",status}]);
    setTimeout(()=>{if(statuses.get(id)?.state!=="preparing")return;const syncing={...status,phase:"syncing_dependencies"};statuses.set(id,syncing);emit([{type:"status",status:syncing},{type:"runtime_progress",run_id:id,phase:"syncing_dependencies",message:"正在同步锁定依赖…",downloaded_bytes:0,total_bytes:null},{type:"output",run_id:id,stream:"stdout",data:btoa("Resolved 12 packages\nInstalling dependencies...\n")}]);},1500);
    setTimeout(()=>{if(statuses.get(id)?.state!=="preparing")return;environmentReady=true;const ready={...status,state:"exited",phase:undefined,exit_code:0,ended_at:"done"};statuses.set(id,ready);emit([{type:"output",run_id:id,stream:"stdout",data:btoa("Environment verified.\n")},{type:"status",status:ready}]);},8000);
  }
  return id;
};
api.getRunStatus=async(id)=>statuses.get(id)??({run_id:id,device_name:"本机 PowerShell",label:JSON.stringify(sessions.get(id)?.request?.command),state:"exited",exit_code:0,error:null,started_at:"",ended_at:""});
api.stopRun=async(id)=>{const status=statuses.get(id);if(!status)return;const stopped={...status,state:"canceled",ended_at:"done"};statuses.set(id,stopped);emit([{type:"status",status:stopped}]);};
useAppStore.setState({workspace,devices:[{id:"local",revision:"demo",name:"本机 PowerShell",is_default:true,transport:"local",local:{shell:"pwsh"},host:"",port:22,username:"",auth:{type:"key",key_path:null},workspace_root:""}],selectedDeviceId:"local",workspaceTree:{...rootTree(tree[""]),tools:{entries:tree.tools,expanded:true,loading:false,error:null},app:{entries:tree.app,expanded:true,loading:false,error:null}}});
function Fixture(){return <div className="app"><WorkspaceRunDialogs/><header className="app-header">工作区运行交互验收（模拟接口）<button onClick={()=>void i18n.changeLanguage(i18n.language==="zh"?"en":"zh")}>中文 / English</button></header><main className="app-main"><aside className="side"><WorkspacePanel collapsed={false} onToggleCollapse={()=>{}}/></aside><section className="center"><div style={{padding:24}}><h3>工作区右键运行</h3><p>在左侧文件、包和空白处打开菜单，检查参数、设置及历史。</p></div></section></main><footer className="app-footer"><RunToolbar/><pre style={{padding:12,overflow:"auto"}}>{JSON.stringify(useWorkspaceRunStore((s)=>s.sessions),null,2)}</pre></footer></div>;}
createRoot(document.getElementById("root")!).render(<Fixture/>);
