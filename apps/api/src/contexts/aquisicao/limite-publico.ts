import { criarLimiteTaxa } from './limite-taxa.js'

/**
 * Limitador GLOBAL por IP das rotas públicas de formulário e LP (chave só `ip`).
 *
 * ⚠️ Roda ANTES dos limitadores por chave e antes de qualquer consulta a `formulario_por_chave`. Sem ele, um
 * atacante com chaves aleatórias VÁLIDAS no formato criava uma entrada por chave nos mapas por (chave+IP) e
 * por formulário, despejando (LRU) as entradas de formulários legítimos, e ainda disparava um SELECT por
 * tentativa. Com ele, cada IP gasta o mesmo balde, qualquer que seja a chave: o excesso é barrado sem tocar
 * em mapa por chave nem em banco. (Escolha documentada: limitador global, não cache negativo de chave.)
 * Por instância, em memória — mesmo contrato de `limite-taxa.ts`.
 */
export const TETO_PUBLICO_POR_IP = 60
const limiteGlobalPorIp = criarLimiteTaxa({ teto: TETO_PUBLICO_POR_IP, janelaMs: 60_000, maxChaves: 50_000 })

export function barrarPorIpGlobal(ip: string, agora: number): { permitido: boolean } {
  return { permitido: limiteGlobalPorIp.permitir(ip, agora) }
}
