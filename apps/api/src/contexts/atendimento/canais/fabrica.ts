import type { Credencial } from '@geracrm/conectores'
import type { TipoCanal } from '@geracrm/shared'
import type { PortaCanal, ResultadoEnvio, ResultadoAcaoMensagem } from './porta.js'
import { CanalPlugZapi } from './plugzapi.js'
import { CanalMetaOficial } from './meta-oficial.js'

/**
 * Constrói o adaptador de canal a partir do provedor + credencial.
 *
 * ⚠️ É aqui que o provedor (rótulo) vira comportamento. O resto do produto usa
 * a PortaCanal e não sabe qual adaptador é. Provedor novo = mais um `case`.
 */
export function criarCanal(provedor: string, cred: Credencial): PortaCanal {
  switch (provedor) {
    case 'plugzapi':
      return new CanalPlugZapi({
        instancia: cred['instancia'] ?? '',
        token: cred['token'] ?? '',
        ...(cred['clientToken'] ? { clientToken: cred['clientToken'] } : {}),
      })
    case 'meta_oficial':
      return new CanalMetaOficial({
        phoneNumberId: cred['phoneNumberId'] ?? '',
        token: cred['token'] ?? '',
      })
    case 'instagram_meta':
      // ⚠️ Instagram Direct (Graph API) — adaptador em desenvolvimento. Degrada
      //    honesto: o canal existe no modelo, o envio recusa tipificado.
      return new CanalNaoImplementado('instagram')
    case 'tiktok_business':
      // ⚠️ TikTok Business Messaging — adaptador em desenvolvimento. Idem.
      return new CanalNaoImplementado('tiktok')
    default:
      return new CanalNaoImplementado('whatsapp_nao_oficial')
  }
}

/** Placeholder honesto: o provedor está no catálogo mas o adaptador não existe. */
class CanalNaoImplementado implements PortaCanal {
  readonly capacidades = {
    janela24h: false, aceitaTemplate: false, riscoBanimento: false, textoLivreSempre: false,
  }
  constructor(readonly tipo: TipoCanal) {}
  async enviarTexto(): Promise<ResultadoEnvio> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'adaptador ainda não implementado' }
  }
  async enviarImagem(): Promise<ResultadoEnvio> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'adaptador ainda não implementado' }
  }
  async enviarAudio(): Promise<ResultadoEnvio> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'adaptador ainda não implementado' }
  }
  async apagarMensagem(): Promise<ResultadoAcaoMensagem> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'adaptador ainda não implementado' }
  }
  async editarMensagem(): Promise<ResultadoAcaoMensagem> {
    return { ok: false, motivo: 'indisponivel', detalhe: 'adaptador ainda não implementado' }
  }
}
