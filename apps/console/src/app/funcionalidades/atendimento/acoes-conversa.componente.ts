import {
  ChangeDetectionStrategy, Component, computed, inject, input, signal,
} from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { CampoComponente, GradeFormComponente, ModalComponente, SelectComponente, type OpcaoSelect } from '../../compartilhado/ui/index.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { PresencaServico } from '../../nucleo/presenca.servico.js'
import {
  MOTIVOS_DEVOLUCAO, TETO_TEXTO, corpoDevolucao, erroDevolucao, erroReatribuicao, pedeRecarregar, podeDevolver, podeReatribuir,
  type AtendimentoDaThread, type MotivoDevolucao,
} from '../../nucleo/devolucao.regras.js'

interface Membro { readonly id: string; readonly nome: string }
type Aberto = 'nenhum' | 'devolver' | 'reatribuir'

/**
 * "Devolver ao agente" e "Reatribuir" no cabeçalho da conversa (G1).
 *
 * ⚠️ Devolver nem sempre entrega ao robô: se o agente do número não fala sozinho
 * agora (sombra/assistido/desligado, fora do recorte), o servidor devolve a conversa
 * à FILA e diz por quê — o aviso aparece NO CORPO do diálogo, que só fecha quando a
 * pessoa confirma que leu ("Entendi"); não some em silêncio.
 * ⚠️ "Devolver" só aparece para quem conduz o atendimento ou para a gestão (o
 * servidor barra os demais com 403 de qualquer jeito).
 * ⚠️ Estado velho (409 sem atendimento/conflito, 403 não é seu): o erro vem com
 * "Recarregar", que traz a conversa como ela está agora.
 *
 * L1e: ui-modal + ui-campo/ui-select da biblioteca.
 */
@Component({
  selector: 'app-acoes-conversa',
  imports: [ModalComponente, GradeFormComponente, CampoComponente, SelectComponente],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mostrarDevolver()) {
      <button class="acao-btn" type="button" (click)="abrirDevolver()"
              title="Devolver a conversa ao agente">Devolver ao agente</button>
    }
    @if (mostrarReatribuir()) {
      <button class="acao-btn" type="button" (click)="abrirReatribuir()"
              title="Passar o atendimento para outra pessoa">Reatribuir</button>
    }
    @if (aviso(); as a) { <span class="aviso-ok" role="status">{{ a }}</span> }

    <ui-modal [aberto]="aberto() !== 'nenhum'" [titulo]="aberto() === 'devolver' ? 'Devolver ao agente' : 'Reatribuir atendimento'"
              largura="p" (fechar)="fechar()">
      @if (aberto() === 'devolver') {
        @if (avisoFila(); as a) {
          <p class="aviso-fila" role="status">{{ a }}</p>
        } @else {
          <p class="ajuda">
            Se o agente deste número responde sozinho agora, ele retoma a conversa e lê o motivo e a
            observação na próxima resposta. Se não (sombra, assistido ou fora do horário dele), a
            conversa volta para a fila da equipe.
          </p>
          <fieldset>
            <legend class="so-leitor">Motivo</legend>
            @for (m of motivos; track m.id) {
              <label class="radio">
                <input type="radio" name="motivo-devolucao" [value]="m.id"
                       [checked]="motivo() === m.id" (change)="motivo.set(m.id)" />
                <span>{{ m.rotulo }}</span>
              </label>
            }
          </fieldset>
          <ui-campo [rotulo]="motivo() === 'outro' ? 'Descreva o motivo' : 'Observação (opcional)'" tipo="textarea"
                    [maxlength]="teto" [obrigatorio]="motivo() === 'outro'"
                    [placeholder]="motivo() === 'outro' ? 'Obrigatório em “Outro”' : 'Ex.: já combinei a entrega para sexta'"
                    [valor]="texto()" (valorChange)="texto.set($event)" />
        }
      } @else {
        <ui-grade-form>
          <ui-select rotulo="Para quem" [largo]="true" [obrigatorio]="true" [opcoes]="opcoesEquipe()" placeholder="Escolha uma pessoa"
                     [valor]="destino() ?? ''" (valorChange)="destino.set($event || null)" />
          <ui-campo rotulo="Motivo" tipo="textarea" [largo]="true" [obrigatorio]="true" [maxlength]="teto"
                    placeholder="Por que está passando adiante?" [valor]="texto()" (valorChange)="texto.set($event)" />
        </ui-grade-form>
      }
      @if (erroServidor(); as e) {
        <div class="erro-linha">
          <p class="erro" role="alert">{{ e }}</p>
          @if (recarregavel()) {
            <button type="button" class="btn btn--secundario btn--pequeno" [disabled]="recarregando()" (click)="recarregar()">
              {{ recarregando() ? 'Recarregando…' : 'Recarregar' }}
            </button>
          }
        </div>
      }
      <div rodape>
        @if (avisoFila()) {
          <button type="button" class="btn btn--primario" (click)="fechar()">Entendi</button>
        } @else {
          <button type="button" class="btn btn--secundario" (click)="fechar()">Cancelar</button>
          <button type="button" class="btn btn--primario" [disabled]="enviando() || !!erroDoFormulario()"
                  [title]="erroDoFormulario() ?? ''" (click)="confirmar()">
            {{ enviando() ? 'Enviando…' : (aberto() === 'devolver' ? 'Devolver' : 'Reatribuir') }}
          </button>
        }
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .acao-btn { font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; padding: 6px 12px; border-radius: 999px;
      border: 1px solid var(--borda-controle); background: var(--fundo); color: var(--texto); }
    .acao-btn:hover { background: var(--superficie-elevada); }
    .acao-btn:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .aviso-ok { font-size: 12px; color: var(--texto-secundario); max-width: 260px; }
    .ajuda { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); }
    fieldset { border: 0; margin: 0 0 var(--espacamento-3); padding: 0; display: grid; gap: var(--espacamento-2); }
    .radio { display: flex; gap: var(--espacamento-2); align-items: center; cursor: pointer; }
    .erro { margin: 0; color: var(--erro); }
    .erro-linha { display: flex; gap: var(--espacamento-2); align-items: center; justify-content: space-between; flex-wrap: wrap; margin-top: var(--espacamento-3); }
    .aviso-fila { margin: 0; padding: var(--espacamento-3); border-radius: var(--raio-controle);
      border: 1px solid var(--borda); background: var(--fundo); color: var(--texto); line-height: 1.4; }
    .so-leitor { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  `,
})
export class AcoesConversaComponente {
  private readonly servico = inject(InboxServico)
  private readonly presenca = inject(PresencaServico)
  private readonly http = inject(HttpClient)

  readonly conversaId = input.required<string>()
  readonly atendimento = input<AtendimentoDaThread | null>(null)

  readonly motivos = MOTIVOS_DEVOLUCAO
  readonly teto = TETO_TEXTO
  readonly mostrarDevolver = computed(() => podeDevolver(this.atendimento(), this.presenca.gestao()))
  readonly mostrarReatribuir = computed(() => podeReatribuir(this.atendimento(), this.presenca.gestao()))

  readonly aberto = signal<Aberto>('nenhum')
  readonly motivo = signal<MotivoDevolucao | null>(null)
  readonly texto = signal('')
  readonly destino = signal<string | null>(null)
  readonly equipe = signal<readonly Membro[]>([])
  readonly enviando = signal(false)
  readonly erroServidor = signal<string | null>(null)
  readonly aviso = signal<string | null>(null)
  /** Devolvida à FILA: o porquê fica no corpo do diálogo até a pessoa confirmar. */
  readonly avisoFila = signal<string | null>(null)
  /** O erro é de estado velho (409/403): oferece "Recarregar". */
  readonly recarregavel = signal(false)
  readonly recarregando = signal(false)

  readonly erroDoFormulario = computed(() => this.aberto() === 'devolver'
    ? erroDevolucao({ motivo: this.motivo(), observacao: this.texto() })
    : erroReatribuicao({ usuarioId: this.destino(), motivo: this.texto() }))

  protected readonly opcoesEquipe = computed<OpcaoSelect[]>(() => this.equipe().map((p) => ({ valor: p.id, rotulo: p.nome })))

  private zerar(aberto: Aberto): void {
    this.motivo.set(null); this.texto.set(''); this.destino.set(null)
    this.erroServidor.set(null); this.aviso.set(null); this.avisoFila.set(null); this.recarregavel.set(false)
    this.aberto.set(aberto)
  }

  abrirDevolver(): void { this.zerar('devolver') }

  async abrirReatribuir(): Promise<void> {
    this.zerar('reatribuir')
    if (this.equipe().length > 0) return
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe'))
      this.equipe.set(r.itens)
    } catch { this.erroServidor.set('Não foi possível carregar a equipe.') }
  }

  fechar(): void { if (!this.enviando()) this.aberto.set('nenhum') }

  async confirmar(): Promise<void> {
    if (this.erroDoFormulario() || this.enviando()) return
    this.enviando.set(true)
    this.erroServidor.set(null); this.recarregavel.set(false)
    const id = this.conversaId()
    if (this.aberto() === 'devolver') {
      const r = await this.servico.devolverAoAgente(id, corpoDevolucao({ motivo: this.motivo()!, observacao: this.texto() }))
      this.enviando.set(false)
      if (!r.ok) { this.falhou(r); return }
      if (r.destino === 'fila') {
        // Fica aberto: a pessoa precisa LER que o agente não assumiu e por quê.
        this.avisoFila.set(r.aviso ?? 'O agente não responde sozinho neste número agora: a conversa voltou para a fila.')
        return
      }
      this.aberto.set('nenhum')
      this.aviso.set('Conversa devolvida ao agente.')
    } else {
      const r = await this.servico.reatribuir(id, { usuarioId: this.destino()!, motivo: this.texto().trim() })
      this.enviando.set(false)
      if (!r.ok) { this.falhou(r); return }
      this.aberto.set('nenhum')
    }
  }

  private falhou(r: { erro: string; codigo: string | null }): void {
    this.erroServidor.set(r.erro)
    this.recarregavel.set(pedeRecarregar(r.codigo))
  }

  async recarregar(): Promise<void> {
    if (this.recarregando()) return
    this.recarregando.set(true)
    try {
      await this.servico.recarregarConversa(this.conversaId())
    } finally {
      this.recarregando.set(false)
    }
    // A conversa já mostra o estado atual (sem atendimento, outra pessoa…): o diálogo não vale mais.
    this.aberto.set('nenhum')
  }
}
