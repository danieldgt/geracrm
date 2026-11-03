import { ChangeDetectionStrategy, Component, inject, input, output, signal, OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ConfirmacaoServico, ToastServico, codigoDoErro, mensagemDeErro } from '../../compartilhado/ui/index.js'
import { ERRO_CONTATO_COM_COMPRA, TEXTO_CONFIRMACAO_ANONIMIZAR, mensagemAnonimizado } from './lgpd.regras.js'

/**
 * Botão "Anonimizar (LGPD)" da ficha do contato (raia H2) — só para ADMIN (a API exige admin
 * ATRIBUÍDO ou staff; no modo fundador ela responde 403 e a tela mostra a mensagem dela).
 *
 * Pedido do titular: apaga os dados pessoais já, sem esperar o prazo de retenção. É IRREVERSÍVEL,
 * por isso a confirmação é DIGITADA. Contato com compra (dado fiscal): a API responde 422
 * `lgpd.contato_com_compra`; a tela oferece a alternativa — apagar só os canais de contato e as
 * conversas, mantendo o vínculo fiscal (`?somenteCanais=true`).
 *
 * Montar na ficha: `<app-anonimizar-contato [contatoId]="f.id" (anonimizou)="recarregar()" />`.
 * O papel só decide o que MOSTRAR; a API barra com 403 de qualquer forma.
 */
interface RespostaAnonimizar { readonly modo: 'completa' | 'canais'; readonly midiasPendentes?: number }

@Component({
  selector: 'app-anonimizar-contato',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (admin()) {
      <button type="button" class="btn btn--secundario btn--pequeno btn--perigo" [disabled]="trabalhando()"
              title="Apaga os dados pessoais deste contato (LGPD). Não tem volta." (click)="anonimizar()">
        {{ trabalhando() ? 'Anonimizando…' : 'Anonimizar (LGPD)' }}
      </button>
    }
  `,
})
export class AnonimizarContatoComponente implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)

  readonly contatoId = input.required<string>()
  readonly anonimizou = output<void>()

  readonly admin = signal(false)
  readonly trabalhando = signal(false)

  async ngOnInit(): Promise<void> {
    try {
      const eu = await firstValueFrom(this.http.get<{ admin?: boolean }>('/v1/config/eu'))
      this.admin.set(eu.admin === true)
    } catch { this.admin.set(false) }
  }

  async anonimizar(): Promise<void> {
    if (this.trabalhando()) return
    const ok = await this.confirmacao.confirmar({
      titulo: 'Anonimizar este contato?',
      mensagem: 'Nome, telefones, e-mail, endereço, documentos, anotações e o conteúdo das conversas serão apagados. '
        + 'O número fica bloqueado para novos envios. Esta ação não tem volta.',
      acao: 'Anonimizar', perigo: true, digitar: TEXTO_CONFIRMACAO_ANONIMIZAR,
    })
    if (!ok) return
    this.trabalhando.set(true)
    try {
      let r: RespostaAnonimizar
      try {
        r = await this.pedir(false)
      } catch (e) {
        if (codigoDoErro(e) !== ERRO_CONTATO_COM_COMPRA) throw e
        // Dado fiscal: só com a confirmação de que o vínculo fiscal fica.
        const soCanais = await this.confirmacao.confirmar({
          titulo: 'Este contato tem compras',
          mensagem: 'O histórico de compra é dado fiscal e permanece. Posso apagar só os canais de contato '
            + '(telefones, e-mail) e o conteúdo das conversas. Deseja continuar?',
          acao: 'Apagar canais e conversas', perigo: true, digitar: TEXTO_CONFIRMACAO_ANONIMIZAR,
        })
        if (!soCanais) return
        r = await this.pedir(true)
      }
      // ⚠️ "Apagado" só quando nada ficou pendente no armazenamento; senão "em remoção".
      this.toast.sucesso(mensagemAnonimizado(r.midiasPendentes ?? 0))
      this.anonimizou.emit()
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível anonimizar o contato.'))
    } finally { this.trabalhando.set(false) }
  }

  private pedir(somenteCanais: boolean): Promise<RespostaAnonimizar> {
    const url = `/v1/contatos/${this.contatoId()}/anonimizar${somenteCanais ? '?somenteCanais=true' : ''}`
    return firstValueFrom(this.http.post<RespostaAnonimizar>(url, {}))
  }
}
