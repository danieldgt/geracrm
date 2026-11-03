import { midiaHabilitada, removerObjeto, subirObjeto, urlAssinada } from '../atendimento/midia/armazenamento.js'

/**
 * Porta mínima do bucket para os arquivos do contato. O adaptador real reusa o armazenamento de
 * mídia do chat (S3/Railway); em teste troca-se por um falso em memória (`definirArquivosBucket`).
 * Sem bucket configurado, `disponivel()` é false e as rotas respondem 503 tipado — nunca quebram.
 */
export interface ArquivosBucket {
  disponivel(): boolean
  subir(chave: string, bytes: Buffer, mime: string): Promise<void>
  remover(chave: string): Promise<void>
  /** `nome`/`tipo`: a URL força download (`attachment`) com esse nome e esse Content-Type. */
  urlAssinada(chave: string, ttlSegundos: number, baixar?: { nome: string; tipo: string }): Promise<string>
}

const real: ArquivosBucket = {
  disponivel: midiaHabilitada,
  subir: subirObjeto,
  remover: removerObjeto,
  urlAssinada: (chave, ttl, baixar) => urlAssinada(chave, ttl, baixar ? { baixarComo: baixar.nome, tipo: baixar.tipo } : {}),
}

let atual: ArquivosBucket = real

export const arquivosBucket = (): ArquivosBucket => atual
/** Só para teste: troca o adaptador; sem argumento volta ao real. */
export function definirArquivosBucket(porta?: ArquivosBucket): void { atual = porta ?? real }
