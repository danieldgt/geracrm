import { Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { chaveLiteral, LIMITES_COMPLIANCE } from '@geracrm/shared'
import {
  BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, PainelComponente, ToastServico,
} from '../../../compartilhado/ui/index.js'
import { ehSemPermissao } from './agente.servico.js'
import { ComplianceServico, type ComplianceDoNumero } from './compliance.servico.js'

/**
 * FRASES PROIBIDAS E GATILHOS DE TRANSFERÊNCIA DO NÚMERO (raia P2; ADR-029 §5).
 *
 * A tela só ACRESCENTA restrição: mostra a base do código (só leitura — não há
 * como desligá-la) e deixa o admin cadastrar frases proibidas e gatilhos de
 * transferência extras, em texto literal. O que for salvo vale na próxima
 * mensagem do agente.
 */
export const COMPLIANCE_PRONTO: boolean = true

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
type Lista = 'frasesProibidas' | 'gatilhosHandoff'

/** Por que o item não entra na lista (null = entra). Pura. */
export function motivoItemInvalido(texto: string, existentes: readonly string[]): string | null {
  const t = texto.replace(/\s+/g, ' ').trim()
  if (t.length < LIMITES_COMPLIANCE.minCaracteres) return `Escreva ao menos ${LIMITES_COMPLIANCE.minCaracteres} caracteres.`
  if (t.length > LIMITES_COMPLIANCE.maxCaracteres) return `Use no máximo ${LIMITES_COMPLIANCE.maxCaracteres} caracteres.`
  if (existentes.length >= LIMITES_COMPLIANCE.maxItens) return `A lista já tem o máximo de ${LIMITES_COMPLIANCE.maxItens} itens.`
  if (existentes.some((e) => chaveLiteral(e) === chaveLiteral(t))) return 'Já está na lista.'
  return null
}

@Component({
  selector: 'app-agente-compliance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, PainelComponente],
  template: `
    <ui-painel>
      <div class="cab">
        <h2 class="txt-secao">Frases proibidas e gatilhos de transferência</h2>
        <p class="dica">O agente nunca envia as frases da base abaixo. Aqui você acrescenta as do seu negócio —
          só acrescenta, nunca desliga a base. Vale a partir da próxima mensagem.</p>
      </div>

      @switch (estado()) {
        @case ('carregando') {
          <div class="esq"><ui-esqueleto altura="20px" largura="60%" /><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /></div>
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o compliance deste número"
            descricao="O servidor não respondeu. Tente de novo em instantes.">
            <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
          </ui-estado>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso" descricao="Seu papel não permite ver esta configuração." />
        }
        @case ('pronto') {
          @if (dados(); as d) {
            <details class="base">
              <summary class="txt-denso">Base que vale sempre ({{ d.base.length }} regras)</summary>
              <ul class="lista-base">
                @for (b of d.base; track b.id) {
                  <li class="txt-denso"><span>{{ b.rotulo }}</span> <span class="exemplo">ex.: “{{ b.exemplo }}”</span></li>
                }
              </ul>
              <p class="dica">Negação não é promessa: “não garantimos entrega amanhã” passa; “garantimos entrega amanhã” não.</p>
            </details>

            @if (!d.podeEditar) {
              <p class="aviso" role="note">Só um administrador altera estas listas. Você está vendo a configuração atual.</p>
            }

            @for (l of listas; track l.id) {
              <section class="bloco">
                <div class="bloco-cab">
                  <h3 class="txt-denso titulo">{{ l.titulo }}</h3>
                  <span class="txt-dados contagem">{{ itens(l.id).length }}/{{ limites.maxItens }}</span>
                </div>
                <p class="dica">{{ l.ajuda }}</p>
                @if (itens(l.id).length === 0) {
                  <p class="vazio txt-denso">{{ l.vazio }}</p>
                } @else {
                  <ul class="chips">
                    @for (item of itens(l.id); track item) {
                      <li class="chip">
                        <span class="chip-texto">{{ item }}</span>
                        @if (d.podeEditar) {
                          <button type="button" class="remover" [attr.aria-label]="'Remover ' + item" (click)="remover(l.id, item)">×</button>
                        }
                      </li>
                    }
                  </ul>
                }
                @if (d.podeEditar) {
                  <div class="adicionar">
                    <label class="campo">
                      <span class="rotulo">{{ l.rotuloCampo }}</span>
                      <input type="text" [value]="rascunho()[l.id]" [attr.maxlength]="limites.maxCaracteres"
                        [attr.aria-invalid]="erroItem()[l.id] ? 'true' : null"
                        (input)="digitar(l.id, $any($event.target).value)" (keydown.enter)="adicionar(l.id)" />
                      @if (erroItem()[l.id]; as e) { <span class="msg-erro">{{ e }}</span> }
                    </label>
                    <ui-botao variante="secundario" (click)="adicionar(l.id)">Adicionar</ui-botao>
                  </div>
                }
              </section>
            }

            @if (erroGeral(); as e) { <p class="aviso aviso--erro" role="alert">{{ e }}</p> }

            @if (d.podeEditar) {
              <div class="acoes">
                @if (alterado()) { <ui-badge tom="atencao">Alterações não salvas</ui-badge> }
                <ui-botao variante="fantasma" [desabilitado]="!alterado() || salvando()" (click)="descartar()">Descartar</ui-botao>
                <ui-botao [carregando]="salvando()" [desabilitado]="!alterado()" (click)="salvar()">Salvar</ui-botao>
              </div>
            }
          }
        }
      }
    </ui-painel>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .cab { display: grid; gap: var(--espacamento-1); margin-bottom: var(--espacamento-4); }
    .cab h2 { margin: 0; }
    .dica { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .esq { display: grid; gap: var(--espacamento-3); }
    .base { border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: var(--espacamento-3);
      margin-bottom: var(--espacamento-4); background: var(--superficie); }
    .base summary { cursor: pointer; color: var(--texto); }
    .lista-base { margin: var(--espacamento-2) 0; padding-left: var(--espacamento-5); display: grid; gap: var(--espacamento-1); }
    .exemplo { color: var(--texto-secundario); }
    .aviso { margin: 0 0 var(--espacamento-4); padding: var(--espacamento-2) var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .aviso--erro { background: var(--erro-suave); }
    .bloco { display: grid; gap: var(--espacamento-2); padding: var(--espacamento-4) 0; border-top: 1px solid var(--borda); min-width: 0; }
    .bloco-cab { display: flex; justify-content: space-between; align-items: baseline; gap: var(--espacamento-2); }
    .titulo { margin: 0; font-weight: 600; }
    .contagem { color: var(--texto-secundario); }
    .vazio { margin: 0; color: var(--texto-secundario); }
    .chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-1); max-width: 100%; min-width: 0;
      padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-completo); background: var(--fundo); font-size: 13px; }
    .chip-texto { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .remover { border: 0; background: transparent; color: var(--texto-secundario); cursor: pointer; font: inherit;
      padding: 0 var(--espacamento-1); border-radius: var(--raio-controle); }
    .remover:hover { color: var(--erro); }
    .remover:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .adicionar { display: grid; grid-template-columns: 1fr auto; gap: var(--espacamento-2); align-items: end; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-1); min-width: 0; }
    .rotulo { font-size: 13px; color: var(--texto); }
    input { min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-2) var(--espacamento-3);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo);
      color: var(--texto); font: inherit; min-width: 0; }
    input:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    input[aria-invalid='true'] { border-color: var(--borda-erro); }
    .msg-erro { font-size: 12px; color: var(--erro); }
    .acoes { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: var(--espacamento-2);
      padding-top: var(--espacamento-4); border-top: 1px solid var(--borda); }
    @media (max-width: 640px) { .adicionar { grid-template-columns: 1fr; } }
  `,
})
export class AgenteComplianceComponente {
  /** Número selecionado na página. */
  readonly canalId = input.required<string>()

  private readonly servico = inject(ComplianceServico)
  private readonly toast = inject(ToastServico)

  readonly limites = LIMITES_COMPLIANCE
  readonly listas: ReadonlyArray<{ id: Lista; titulo: string; ajuda: string; vazio: string; rotuloCampo: string }> = [
    {
      id: 'frasesProibidas', titulo: 'Frases proibidas extras',
      ajuda: 'A frase da resposta que contiver o termo sai antes do envio (negada, como “não trabalhamos com consignação”, passa).',
      vazio: 'Nenhuma frase extra — vale só a base.', rotuloCampo: 'Nova frase ou termo proibido',
    },
    {
      id: 'gatilhosHandoff', titulo: 'Gatilhos de transferência extras',
      ajuda: 'Se o cliente escrever um destes termos, a conversa vai para um vendedor da equipe.',
      vazio: 'Nenhum gatilho extra — valem só os da base (pedido de humano, reclamação, “pare”…).', rotuloCampo: 'Novo termo que transfere',
    },
  ]

  readonly estado = signal<Estado>('carregando')
  readonly dados = signal<ComplianceDoNumero | null>(null)
  /** O que está na tela (editado, ainda não salvo). */
  readonly editado = signal<Record<Lista, readonly string[]>>({ frasesProibidas: [], gatilhosHandoff: [] })
  readonly rascunho = signal<Record<Lista, string>>({ frasesProibidas: '', gatilhosHandoff: '' })
  readonly erroItem = signal<Record<Lista, string | null>>({ frasesProibidas: null, gatilhosHandoff: null })
  readonly erroGeral = signal<string | null>(null)
  readonly salvando = signal(false)

  readonly alterado = computed(() => {
    const d = this.dados()
    if (!d) return false
    const e = this.editado()
    return JSON.stringify(e.frasesProibidas) !== JSON.stringify(d.frasesProibidas)
      || JSON.stringify(e.gatilhosHandoff) !== JSON.stringify(d.gatilhosHandoff)
  })

  constructor() {
    effect(() => {
      this.canalId()
      untracked(() => void this.carregar())
    })
  }

  itens(l: Lista): readonly string[] { return this.editado()[l] }

  async carregar(): Promise<void> {
    const canal = this.canalId()
    this.estado.set('carregando')
    this.erroGeral.set(null)
    try {
      const d = await this.servico.ler(canal)
      if (canal !== this.canalId()) return
      this.dados.set(d)
      this.editado.set({ frasesProibidas: d.frasesProibidas, gatilhosHandoff: d.gatilhosHandoff })
      this.estado.set('pronto')
    } catch (e) {
      if (canal !== this.canalId()) return
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  digitar(l: Lista, valor: string): void {
    this.rascunho.update((r) => ({ ...r, [l]: valor }))
    if (this.erroItem()[l]) this.erroItem.update((r) => ({ ...r, [l]: null }))
  }

  adicionar(l: Lista): void {
    const texto = this.rascunho()[l]
    const motivo = motivoItemInvalido(texto, this.editado()[l])
    if (motivo) { this.erroItem.update((r) => ({ ...r, [l]: motivo })); return }
    this.editado.update((e) => ({ ...e, [l]: [...e[l], texto.replace(/\s+/g, ' ').trim()] }))
    this.rascunho.update((r) => ({ ...r, [l]: '' }))
  }

  remover(l: Lista, item: string): void {
    this.editado.update((e) => ({ ...e, [l]: e[l].filter((i) => i !== item) }))
  }

  descartar(): void {
    const d = this.dados()
    if (d) this.editado.set({ frasesProibidas: d.frasesProibidas, gatilhosHandoff: d.gatilhosHandoff })
    this.erroGeral.set(null)
  }

  async salvar(): Promise<void> {
    const d = this.dados()
    if (!d || this.salvando()) return
    this.salvando.set(true)
    this.erroGeral.set(null)
    const e = this.editado()
    const r = await this.servico.salvar(this.canalId(), { frasesProibidas: [...e.frasesProibidas], gatilhosHandoff: [...e.gatilhosHandoff] })
    this.salvando.set(false)
    if (!r.ok) {
      this.erroGeral.set(r.status === 403
        ? 'Seu papel não permite alterar estas listas. Peça a um administrador.'
        : r.erro.mensagem ?? 'Não foi possível salvar. Tente de novo.')
      return
    }
    this.dados.set({ ...d, ...r.salvo })
    this.editado.set(r.salvo)
    this.toast.sucesso('Compliance salvo. Vale a partir da próxima mensagem do agente.')
  }
}
