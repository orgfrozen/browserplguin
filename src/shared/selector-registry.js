import { ERROR_CODES, RunnerError } from './errors.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || value instanceof RegExp || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const CHATGPT_SEMANTIC_V1 = deepFreeze({
  id: 'chatgpt-semantic-v1',
  version: 1,
  selectors: {
    composerButtons: ['button[aria-label]', 'button[title]', 'button[data-testid]'],
    assistantMessages: ['[data-message-author-role="assistant"]', '[data-testid^="conversation-turn-"]'],
    projectLinks: ['a[href*="/g/"]', 'a[href*="/project"]', '[role="link"]'],
    fileInputs: ['input[type="file"]'],
    editor: 'textarea, [contenteditable="true"]',
    semanticButtons: 'button, [role="button"]',
    projectAnchors: 'a[href], [role="link"]',
    dialogs: '[role="dialog"]',
    attachmentNodes: '[data-testid], [aria-label], [title], [role], span, div, button',
    progressBars: '[role="progressbar"]',
    accessNodes: 'textarea, [contenteditable="true"], button, [role="button"], a[href], input, iframe, form'
  },
  patterns: {
    project: {
      newProject: [/\b(?:new|create) project\b/i, /(?:新建|创建|添加)\s*项目/i, /(?:新規\s*プロジェクト|プロジェクトを作成)/i, /^新项目$/],
      projectSection: [/^projects?$/i, /^项目$/, /^專案$/, /^プロジェクト$/i],
      projectName: [/project name/i, /项目名称|项目名|名称/i, /プロジェクト名/i],
      projectMenu: [
        /project (?:options|menu|more)/i,
        /项目.*(?:选项|菜单|更多|设置)/i,
        /プロジェクト.*(?:オプション|メニュー|その他|設定)/i
      ],
      projectDetails: [/^show project details$/i, /^显示项目详情$/, /^顯示專案詳細資料$/, /^プロジェクトの詳細を表示$/],
      more: [/^more$/i, /^更多$/, /^その他$/],
      projectSettings: [/project settings/i, /项目设置|專案設定/i, /プロジェクト設定/i],
      share: [/^share$/i, /^分享$/, /^共享$/, /^共有$/],
      projectInstructions: [/project instructions?/i, /^指令$/, /项目(?:说明|指令|指示)/i, /プロジェクト(?:の)?指示/i],
      save: [/^save$/i, /^保存$/, /^儲存$/, /^保存する$/],
      deleteProject: [/delete project/i, /^delete$/i, /删除项目|刪除專案/i, /^删除$/, /^刪除$/, /プロジェクトを削除/i, /^削除$/i],
      confirmDelete: [/^delete(?: project)?$/i, /^删除(?:项目)?$/, /^从[“"]聊天[”"]和[“"]工作[”"]中删除$/, /^刪除(?:專案)?$/, /^削除(?:する|プロジェクト)?$/i],
      createProject: [/^create(?: project)?$/i, /^创建(?:项目)?$/i, /^(?:プロジェクトを)?作成$/i]
    },
    composer: {
      attachMenu: [
        /add (?:files?|photos?)(?: and more)?/i,
        /attach (?:files?|photos?)/i,
        /添加(?:文件|照片)(?:及其他|和更多)?/i,
        /添加文件及其他/i,
        /ファイル.*追加|添付/i
      ],
      uploadFile: [
        /add photos? and files?/i,
        /upload from computer/i,
        /添加照片和文件|从电脑上传|上传文件/i,
        /写真とファイルを追加|コンピュータからアップロード/i
      ],
      send: [/\bsend(?: prompt)?\b/i, /send-button/i, /发送|傳送/i, /送信/i, /submit/i],
      uploadPending: [
        /uploading|processing|attaching/i,
        /上传中|正在上传|处理中|正在处理|正在添加/i,
        /アップロード中|処理中/i
      ]
    },
    access: {
      loginPath: [/^\/auth\/(?:login|log-in)(?:\/|$)/i, /^\/(?:login|log-in)(?:\/|$)/i],
      challengeTitle: [
        /^just a moment(?:\.\.\.)?$/i,
        /security (?:check|verification)/i,
        /verify (?:you are|that you are) human/i,
        /checking your browser/i
      ],
      loginText: [/^log\s*in$/i, /^sign\s*in$/i, /^登录$/, /^登入$/, /^ログイン$/],
      challengeText: [/^verify (?:you are|that you are) human$/i, /^i(?:'|’)m not a robot$/i]
    }
  }
});

const PROFILES = new Map([[CHATGPT_SEMANTIC_V1.id, CHATGPT_SEMANTIC_V1]]);

export const ACTIVE_SELECTOR_PROFILE_ID = CHATGPT_SEMANTIC_V1.id;

export function getSelectorProfile(id) {
  const profile = PROFILES.get(String(id ?? ''));
  if (profile) return profile;
  throw new RunnerError(
    ERROR_CODES.UI_SELECTOR_INCOMPATIBLE,
    `Unknown ChatGPT selector profile: ${String(id ?? '(empty)')}`,
    { selectorProfileId: id ?? null }
  );
}

export function getActiveSelectorProfile() {
  return getSelectorProfile(ACTIVE_SELECTOR_PROFILE_ID);
}

export function getActiveSelectorProfileMetadata() {
  const profile = getActiveSelectorProfile();
  return Object.freeze({ id: profile.id, version: profile.version });
}
