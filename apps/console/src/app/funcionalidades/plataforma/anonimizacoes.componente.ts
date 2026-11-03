import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ConfirmacaoServico, ToastServico, mensagemDeErro } from '../../compartilhado/ui/index.js'
import {
  TEXTO_CONFIRMACAO_AUTOMATICA, linhasPorMotivo, periodoDoMes, resumoPrevia,
  type PreviaLgpd, type RelatorioAnonimizacao,
} from '../crm/lgpd.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro'

/**
 * ANONIMIZAÇÕES (raia H2) — painel de Privacidade e LGPD, só para admin.
 *
 *  - ANONIMIZAÇÃO AUTOMÁTICA (retenção + opt-out): DESLIGADA por padrão. Ligar mostra antes a PRÉVIA
 *    (`GET /v1/lgpd/previa`, modo relatório: quantos seriam anonimizados, por motivo) e pede
 *    confirmação digitada; só então `POST /v1/lgpd/automatica {ativar:true, confirmo:true}` (auditado).
 *    A API exige admin atribuído ou staff; o 403 dela vira a mensagem da tela.
 *  - RELATÓRIO do mês (`GET /v1/lgpd/relatorio`): contagens por motivo e a mídia ainda em remoção do
 *    armazenamento. Nenhum dado pessoal.
 */
@Component({
  selector: 'app-anonimizacoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="bloco" aria-labelledby="titulo-anonimizacoes">
      <h3 id="titulo-anonimizacoes" class="txt-secao">Anonimizações</h3>
      @switch (estado()) {
        @case ('carregando') { <div class="esq" aria-hidden="true"></div> }
        @case ('erro') {
          <div class="vazio txt-corpo">Não foi possível carregar a anonimização.
            <button class="btn btn--secundario" type="button" (click)="carregar()">Tentar de novo</button></div>
        }
        @case ('pronto') {
          @if (previa(); as p) {
            <div class="automatica">
              <div class="txt-corpo">
                <strong>Anonimização automática: {{ p.ativa ? 'ligada' : 'desligada' }}</strong>
                <p class="dica">
                  @if (p.ativa) {
                    Todo dia, contatos descartados há mais de {{ p.retencaoMeses }} meses sem nenhuma interação e quem pediu para sair há mais de 15 dias têm os dados pessoais apagados.
                  } @else {
                    Ligada, apaga todo dia os dados pessoais de contatos descartados há mais de {{ p.retencaoMeses }} meses (sem compra nem interação) e de quem pediu para sair há mais de 15 dias.
                  }
                  {{ resumo(p) }}
                </p>
              </div>
              <button class="btn" type="button" [class.btn--perigo]="!p.ativa" [class.btn--secundario]="p.ativa"
                      [disabled]="alterando()" (click)="alternar(p)">
                {{ alterando() ? 'Salvando…' : (p.ativa ? 'Desligar' : 'Ligar…') }}
              </button>
            </div>
          }
          <p class="dica txt-corpo">Contatos que tiveram os dados pessoais apagados neste mês, por motivo.</p>
          @if (relatorio(); as r) {
            @if (r.total === 0) {
              <p class="vazio txt-corpo">Nenhum contato anonimizado neste mês.</p>
            } @else {
              <ul class="lista">
                @for (l of linhas(); track l.motivo) {
                  <li><span class="txt-corpo">{{ l.rotulo }}</span><strong class="txt-corpo">{{ l.total }}</strong></li>
                }
                <li class="total"><span class="txt-corpo">Total no mês</span><strong class="txt-corpo">{{ r.total }}</strong></li>
              </ul>
              @if (r.porModo.canais > 0) {
                <p class="dica txt-corpo">{{ r.porModo.canais }} com compra: só canais de contato e conversas foram apagados; o vínculo fiscal permanece.</p>
              }
            }
            @if (r.midiasPendentes > 0) {
              <p class="dica txt-corpo">{{ r.midiasPendentes }} arquivo(s) em remoção do armazenamento; {{ r.midiasRemovidas }} removido(s) neste mês.</p>
            } @else if (r.midiasRemovidas > 0) {
              <p class="dica txt-corpo">{{ r.midiasRemovidas }} arquivo(s) removido(s) do armazenamento neste mês; nada pendente.</p>
            }
            @if (r.falhas > 0) {
              <p class="dica txt-corpo">{{ r.falhas }} contato(s) não puderam ser anonimizados na última passada; serão tentados de novo.</p>
            }
          }
        }
      }
    </section>
  `,
  styles: `
    :host { display: block; margin-top: var(--espacamento-5); }
    h3 { margin: 0 0 var(--espacamento-1); }
    .dica { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); }
    .esq { height: 96px; border-radius: var(--raio-controle); background: var(--superficie); }
    .vazio { color: var(--texto-suave); display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-3); margin: 0; }
    .automatica { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--espacamento-3);
      padding: var(--espacamento-3); margin-bottom: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-controle); }
    .automatica > div { flex: 1 1 280px; min-width: 0; }
    .automatica .dica { margin: var(--espacamento-1) 0 0; }
    .lista { list-style: none; margin: 0 0 var(--espacamento-3); padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-controle); }
    .lista li { display: flex; justify-content: space-between; gap: var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3); }
    .lista li + li { border-top: 1px solid var(--borda); }
    .lista .total { background: var(--superficie); }
  `,
})
export class AnonimizacoesComponente implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)

  readonly estado = signal<Estado>('carregando')
  readonly relatorio = signal<RelatorioAnonimizacao | null>(null)
  readonly previa = signal<PreviaLgpd | null>(null)
  readonly linhas = signal<ReturnType<typeof linhasPorMotivo>>([])
  readonly alterando = signal(false)

  ngOnInit(): void { void this.carregar() }

  resumo(p: PreviaLgpd): string { return resumoPrevia(p) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    const { de, ate } = periodoDoMes(new Date())
    try {
      const [r, p] = await Promise.all([
        firstValueFrom(this.http.get<RelatorioAnonimizacao>(`/v1/lgpd/relatorio?de=${de}&ate=${ate}`)),
        firstValueFrom(this.http.get<PreviaLgpd>('/v1/lgpd/previa')),
      ])
      this.relatorio.set(r)
      this.linhas.set(linhasPorMotivo(r))
      this.previa.set(p)
      this.estado.set('pronto')
    } catch { this.estado.set('erro') }
  }

  async alternar(p: PreviaLgpd): Promise<void> {
    if (this.alterando()) return
    const ativar = !p.ativa
    if (ativar) {
      // Modo relatório: a prévia é relida na hora, para a pessoa confirmar o número de AGORA.
      let atual: PreviaLgpd
      try { atual = await firstValueFrom(this.http.get<PreviaLgpd>('/v1/lgpd/previa')) } catch (e) {
        this.toast.erro(mensagemDeErro(e, 'Não foi possível calcular a prévia.')); return
      }
      this.previa.set(atual)
      const ok = await this.confirmacao.confirmar({
        titulo: 'Ligar a anonimização automática?',
        mensagem: `${resumoPrevia(atual)} Os dados pessoais apagados não têm volta.`,
        acao: 'Ligar', perigo: true, digitar: TEXTO_CONFIRMACAO_AUTOMATICA,
      })
      if (!ok) return
    }
    this.alterando.set(true)
    try {
      await firstValueFrom(this.http.post('/v1/lgpd/automatica', ativar ? { ativar, confirmo: true } : { ativar }))
      this.toast.sucesso(ativar ? 'Anonimização automática ligada.' : 'Anonimização automática desligada.')
      await this.carregar()
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível alterar a anonimização automática.'))
    } finally { this.alterando.set(false) }
  }
}
