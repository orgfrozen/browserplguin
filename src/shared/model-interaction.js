import { parseTaskStatus } from './status-protocol.js';

export const AUTONOMY_CONTINUATION_PROMPT = `不需要等待人工确认。请根据当前 Task、源码、项目约束和你的专业经验，自行选择最稳妥、最小改动、最符合现有架构的方案继续执行。
如果存在多个可行方案，请自行推荐并采用你认为最佳的一个，不要扩大 Task 范围。
如果缺少 API key、Token、密码、验证码、生产地址或其它真实外部凭证，不得伪造或编造真实密钥、Token、密码或验证码；优先使用项目已有安全配置、可验证的替代方案，或跳过被该外部条件阻塞的步骤并继续完成其它可以可靠完成的工作。
只有当客观条件确实无法绕开、且继续执行会导致不可靠或危险结果时，才明确说明硬阻塞原因，并在回复末尾输出 <TASK_STATUS>BLOCKED</TASK_STATUS>。
否则请继续完成实现、验证和 PatchSync Patch 交付，不需要再次询问是否确认。`;

const QUESTION_PATTERNS = [
  /[?？]/,
  /(?:是否|要不要|需不需要|可以.*吗|能否|请确认|确认.*(?:吗|？)|你希望|你想|请选择|选择.*(?:还是|或)|应该.*(?:还是|或)|请提供)/i,
  /(?:api\s*key|access\s*token|token|password|密码|密钥|验证码).*(?:提供|需要|缺少|missing|required)/i,
  /(?:would you like|do you want|should i|shall i|please confirm|which (?:option|approach)|choose|select|provide .*?(?:key|token|password))/i
];

export function classifyAssistantInteraction(text) {
  const value = String(text ?? '').trim();
  if (!value || parseTaskStatus(value)) return null;
  return QUESTION_PATTERNS.some(pattern => pattern.test(value)) ? 'AUTONOMY_CONTINUE' : null;
}
