import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { ConfigAgendaDoAgente, TemplateAprovadoResumo } from '@geracrm/shared'
import { BotaoComponente, EsqueletoComponente, PainelComponente, ToastServico } from '../../../compartilhado/ui/index.js'
import { ModulosServico } from '../../../nucleo/modulos.servico.js'
import { falhaDe } from './agente.servico.js'
import { AtivasServico } from './ativas.servico.js'
import {
  avisoDeTemplates, corpoAgendaAgente, efeitoDaChave, mostraTemplates, mudouAgenda, type EstadoAgendaAgente,
} from './agenda-agente.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro'

/**
 * "Reuniões" em Agente › Configuração (raia C3): a chave POR NÚMERO "O agente pode marcar
 * reuniões" (padrão desligada) e os templates dos avisos ao cliente no oficial.
 *
 * ⚠️ Só aparece com o módulo Agenda ligado (a API responde 404 sem ele). Desligada, a ferramenta
 *    `agendar_reuniao` não entra no turno do agente; o botão da conversa segue para a equipe.
 * ⚠️ Salvar é de admin: 403 vira aviso no bloco, a tela não quebra.
 */
@Component({
  selector: 'app-agente-agenda',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, BotaoComponente, EsqueletoComponente],
  template: `
    @if (modulos.agendaAtiva()) {
      <ui-painel>
        <h2 class="txt-secao secao">Reuniões</h2>
        @switch (estado()) {
          @case ('carregando') { <div class="esq"><ui-esqueleto altura="20px" largura="50%" /><ui-esqueleto altura="40px" /></div> }
          @case ('erro') {
            <p class="aviso aviso--erro" role="alert">Não foi possível carregar a configuração de reuniões.
              <button type="button" class="link" (click)="carregar()">Tentar de novo</button></p>
          }
          @case ('pronto') {
            <label class="chave">
              <input type="checkbox" [checked]="form().reunioes" (change)="mudar({ reunioes: $any($event.target).checked })" />
              <span>O agente pode marcar reuniões</span>
            </label>
            <p class="obs">{{ efeito() }}</p>

            @if (templatesVisiveis()) {
              <div class="grade-2">
                <label class="campo"><span>Template do lembrete (fora de 24 h)</span>
                  <select [value]="form().templateLembreteId ?? ''" (change)="mudar({ templateLembreteId: $any($event.target).value || null })">
                    <option value="">Nenhum — não lembrar fora de 24 h</option>
                    @if (form().templateLembreteId; as id) { @if (!naLista(id)) { <option [value]="id">Template escolhido</option> } }
                    @for (t of templates(); track t.id) {
                      <option [value]="t.id" [disabled]="!t.compativel">{{ t.nome }} ({{ t.idioma }}){{ t.compativel ? '' : ' — usa variável além do primeiro nome' }}</option>
                    }
                  </select>
                </label>
                <label class="campo"><span>Template do convite para remarcar (no-show)</span>
                  <select [value]="form().templateReagendarId ?? ''" (change)="mudar({ templateReagendarId: $any($event.target).value || null })">
                    <option value="">Nenhum — no-show vai para uma pessoa</option>
                    @if (form().templateReagendarId; as id) { @if (!naLista(id)) { <option [value]="id">Template escolhido</option> } }
                    @for (t of templates(); track t.id) {
                      <option [value]="t.id" [disabled]="!t.compativel">{{ t.nome }} ({{ t.idioma }}){{ t.compativel ? '' : ' — usa variável além do primeiro nome' }}</option>
                    }
                  </select>
                </label>
              </div>
              @if (templatesFalhou()) {
                <p class="aviso" role="status">Não foi possível carregar os templates aprovados.
                  <button type="button" class="link" (click)="carregarTemplates(null)">Tentar de novo</button></p>
              } @else if (templatesCursor()) {
                <button type="button" class="link" (click)="carregarTemplates(templatesCursor())">Carregar mais templates</button>
              }
              @if (avisoTemplates(); as a) { <p class="aviso" role="status">{{ a }}</p> }
            } @else {
              <p class="obs">Neste número os lembretes saem como texto, dentro da cota diária de aquecimento.</p>
            }
            @if (erroSalvar(); as e) { <p class="aviso aviso--erro" role="alert">{{ e }}</p> }
            <div class="acoes">
              <ui-botao variante="secundario" [carregando]="salvando()" [desabilitado]="!mudou()" (click)="salvar()">
                {{ salvando() ? 'Salvando…' : 'Salvar reuniões' }}
              </ui-botao>
            </div>
          }
        }
      </ui-painel>
    }
  `,
  styles: `
    :host { display: block; min-width: 0; margin-top: var(--espacamento-4); }
    .secao { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .esq { display: grid; gap: var(--espacamento-3); }
    .chave { display: flex; gap: var(--espacamento-2); align-items: center; cursor: pointer; font-weight: 600; }
    .obs { margin: var(--espacamento-2) 0; color: var(--texto-secundario); font-size: 13px; }
    .grade-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: var(--espacamento-3); margin-top: var(--espacamento-3); }
    .campo { display: grid; gap: var(--espacamento-1); min-width: 0; }
    .campo span { color: var(--texto-secundario); font-size: 13px; }
    select { font: inherit; padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--fundo); color: var(--texto); width: 100%; min-width: 0; }
    select:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .aviso { margin: var(--espacamento-2) 0 0; font-size: 13px; color: var(--texto); }
    .aviso--erro { color: var(--erro); }
    .acoes { display: flex; justify-content: flex-end; margin-top: var(--espacamento-3); }
    .link { font: inherit; background: none; border: 0; padding: 0; color: var(--acao); cursor: pointer; text-decoration: underline; }
  `,
})
export class AgenteAgendaComponente {
  private readonly http = inject(HttpClient)
  private readonly ativas = inject(AtivasServico)
  private readonly toast = inject(ToastServico)
  protected readonly modulos = inject(ModulosServico)

  readonly canalId = input.required<string>()

  readonly estado = signal<Estado>('carregando')
  readonly dados = signal<EstadoAgendaAgente | null>(null)
  readonly form = signal<ConfigAgendaDoAgente>({ reunioes: false, templateLembreteId: null, templateReagendarId: null })
  readonly original = signal<ConfigAgendaDoAgente>({ reunioes: false, templateLembreteId: null, templateReagendarId: null })
  readonly templates = signal<readonly TemplateAprovadoResumo[]>([])
  readonly templatesCursor = signal<string | null>(null)
  readonly templatesFalhou = signal(false)
  readonly salvando = signal(false)
  readonly erroSalvar = signal<string | null>(null)

  readonly efeito = computed(() => efeitoDaChave(this.form().reunioes, this.dados()?.modoDoNumero ?? 'desligado'))
  readonly templatesVisiveis = computed(() => mostraTemplates(this.dados()?.tipoCanal ?? ''))
  readonly avisoTemplates = computed(() => avisoDeTemplates(this.dados()?.tipoCanal ?? '', this.form()))
  readonly mudou = computed(() => mudouAgenda(this.form(), this.original()))

  constructor() {
    // Recarrega ao trocar de número — e só com o módulo ligado (sem módulo, a API daria 404).
    effect(() => {
      this.canalId()
      if (this.modulos.agendaAtiva()) untracked(() => void this.carregar())
    })
  }

  naLista(id: string): boolean { return this.templates().some((t) => t.id === id) }

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.erroSalvar.set(null)
    try {
      const d = await firstValueFrom(this.http.get<EstadoAgendaAgente>(`/v1/canais/${this.canalId()}/agente/agenda`))
      const f = { reunioes: d.reunioes, templateLembreteId: d.templateLembreteId, templateReagendarId: d.templateReagendarId }
      this.dados.set(d); this.form.set(f); this.original.set(f)
      this.estado.set('pronto')
      if (mostraTemplates(d.tipoCanal)) void this.carregarTemplates(null)
    } catch { this.estado.set('erro') }
  }

  async carregarTemplates(cursor: string | null): Promise<void> {
    this.templatesFalhou.set(false)
    try {
      const p = await this.ativas.listarTemplates(this.canalId(), cursor)
      this.templates.update((a) => (cursor ? [...a, ...p.itens] : p.itens))
      this.templatesCursor.set(p.proximoCursor)
    } catch { this.templatesFalhou.set(true) } // parcial: o resto do bloco segue
  }

  mudar(parte: Partial<ConfigAgendaDoAgente>): void {
    this.form.update((f) => ({ ...f, ...parte }))
    this.erroSalvar.set(null)
  }

  async salvar(): Promise<void> {
    if (this.salvando() || !this.mudou()) return
    this.salvando.set(true); this.erroSalvar.set(null)
    try {
      await firstValueFrom(this.http.put(`/v1/canais/${this.canalId()}/agente/agenda`, corpoAgendaAgente(this.form())))
      this.original.set(this.form())
      this.toast.sucesso('Configuração de reuniões salva.')
    } catch (e) {
      const f = falhaDe(e)
      this.erroSalvar.set(f.status === 403 ? 'Só um administrador muda esta configuração.' : f.erro.mensagem ?? 'Não foi possível salvar.')
    } finally {
      this.salvando.set(false)
    }
  }
}
