/**
 * @seo-tools/shared/google — общая работа с Google API для серверов семейства (gsc, ga4).
 *
 * ОТДЕЛЬНЫЙ subpath (как ./serp): тянет google-auth-library, поэтому импортируется
 * только Google-серверами и не попадает в бандлы Яндекс-серверов.
 */
export { createGoogleAuth, type GoogleAuth, type GoogleAuthConfig, isInvalidGrant, saJsonFileName } from './auth.js';
export { createLoopbackManager, type LoopbackManager, type OauthFlow } from './loopback.js';
export { type GoogleOauthToolsOptions, registerGoogleOauthTools } from './oauth-tools.js';
