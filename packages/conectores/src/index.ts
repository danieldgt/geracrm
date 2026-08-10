export * from './porta.js'
export * from './credencial.js'
export * from './catalogo.js'
export * from './sonda.js'
export { autenticarGeraCloud, KEYCLOAK_GERACLOUD, CAMINHO_SONDA_GERACLOUD } from './geracloud/autenticacao.js'
export type { Autenticado, ResultadoAuth } from './geracloud/autenticacao.js'
export { ConectorGeraCloud, CAPACIDADES_GERACLOUD } from './geracloud/conector.js'

// ⚠️ `conformidade` NÃO entra no índice público: ela importa `vitest`, e este
//    índice é consumido por Angular, Expo E API em RUNTIME. Re-exportá-la faz
//    qualquer `import '@geracrm/conectores'` arrastar o vitest para o processo —
//    e vitest importado fora de um teste derruba tudo com "failed to access its
//    internal state". O teste de conformidade importa direto de
//    './conformidade.js' (ver conector.test.ts).
