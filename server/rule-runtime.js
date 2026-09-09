import fs from 'node:fs';
import { validateRuleBundle, ruleBundleStatus } from '../shared/rule-bundle.js';
import { installImage2Rules } from '../shared/image2-rule-data.js';
import { installEditorialRules } from '../shared/editorial-rule-runtime.js';
import { businessCoreStatus } from '../shared/business-core-integrity.js';

// Capture the same checked-in rules for every task in this process.
export const activeRuleBundle = validateRuleBundle(JSON.parse(fs.readFileSync(new URL('../config/business-rules.json', import.meta.url), 'utf8')));
if (process.env.PPT_RULE_BUNDLE_PATH) {
  const override = validateRuleBundle(JSON.parse(fs.readFileSync(process.env.PPT_RULE_BUNDLE_PATH, 'utf8')));
  if (override.sha256 !== activeRuleBundle.sha256) throw new Error('外部规则与通用业务核心不一致，请先同步两端规则再启动');
}
installImage2Rules(activeRuleBundle.payload.image2);
installEditorialRules(activeRuleBundle.payload);
export const activeRules = { ...ruleBundleStatus(activeRuleBundle, 'business-core'), core: businessCoreStatus };
