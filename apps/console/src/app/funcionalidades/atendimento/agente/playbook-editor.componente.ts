import { Component, ChangeDetectionStrategy, computed, input, output, signal } from '@angular/core'
import {
  LIMITES_COMPLIANCE, LIMITES_PLAYBOOK, MENSAGENS_PLAYBOOK, PLACEHOLDERS_PLAYBOOK, ROTULO_MENSAGEM, TONS,
  type AcaoPlaybook, type ChaveMensagemPlaybook, type ComplianceExtra, type ConteudoPlaybook, type ItemQualificacao,
  type SlotQualificacao,
} from '@geracrm/shared'
import { BadgeComponente, BotaoComponente } from '../../../compartilhado/ui/index.js'
import type { EstadoPlaybookApi } from './playbook.servico.js'
import { ROTULO_SLOT, adicionarChip, erroDoPrefixo, moverItem, numeroOuNulo, slotsLivres } from './playbook.regras.js'

type Base = EstadoPlaybookApi['base']
type Lista = 'frasesProibidas' | 'gatilhosHandoff'

/**
 * EDITOR DO PLAYBOOK (P17) — as seis seções do conteúdo. Sem estado próprio de
 * dados: recebe o conteúdo e emite o conteúdo inteiro a cada mudança (o pai
 * guarda o rascunho editado e sabe se há alteração não salva).
 *
 * ⚠️ O que protege NÃO aparece como editável: a base de frases do código e as
 *    ações sempre ligadas ficam ao lado, só leitura. A tela só acrescenta.
 */
@Component({
  selector: 'app-playbook-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponente, BotaoComponente],
  template: `
    @let c = conteudo();
    <fieldset class="secoes" [disabled]="!editavel()">
      <!-- Tom e estilo -->
      <section class="secao" id="pb-estilo">
        <h3 class="txt-secao">Tom e estilo</h3>
        <p class="dica">Os dois máximos são APLICADOS no filtro de saída — não é só um pedido ao modelo. Vazio = sem limite extra.</p>
        <div class="grade">
          <label class="campo">Tratamento
            <select [value]="c.estilo.tratamento" (change)="estilo('tratamento', $any($event.target).value)">
              <option value="voce">você</option><option value="senhor_senhora">o senhor / a senhora</option>
            </select>
          </label>
          <label class="campo">Máx. caracteres por mensagem
            <input type="number" [attr.min]="lim.maxCaracteresMin" [attr.max]="lim.maxCaracteresMax" [value]="c.estilo.maxCaracteres ?? ''"
                   (change)="estilo('maxCaracteres', num($any($event.target).value))" placeholder="sem limite" />
          </label>
          <label class="campo">Máx. perguntas por mensagem
            <input type="number" [attr.min]="lim.maxPerguntasMin" [attr.max]="lim.maxPerguntasMax" [value]="c.estilo.maxPerguntas ?? ''"
                   (change)="estilo('maxPerguntas', num($any($event.target).value))" placeholder="sem limite" />
          </label>
        </div>
        @if (erro('estilo.maxCaracteres') ?? erro('estilo.maxPerguntas') ?? erro('estilo.tratamento'); as e) { <p class="erro" role="alert">{{ e }}</p> }
        <label class="campo">Orientações de conduta
          <textarea rows="4" [attr.maxlength]="lim.orientacoes" [value]="c.estilo.orientacoes" (input)="estilo('orientacoes', $any($event.target).value)"
                    placeholder="Como abordar, ritmo, como tratar objeções. Fatos (prazo, preço, condição) vão na base de conhecimento."></textarea>
          <span class="contador txt-dados">{{ c.estilo.orientacoes.length }}/{{ lim.orientacoes }}</span>
        </label>
        @if (erro('estilo.orientacoes'); as e) { <p class="erro" role="alert">{{ e }}</p> }
      </section>

      <!-- Persona -->
      <section class="secao" id="pb-persona">
        <h3 class="txt-secao">Persona</h3>
        <p class="dica">Identificar-se como assistente virtual não é opção: o sistema sempre se apresenta como IA.</p>
        <div class="grade">
          <label class="campo">Nome da assistente
            <input type="text" maxlength="40" [value]="c.persona.nome" (input)="persona('nome', $any($event.target).value)" />
          </label>
          <label class="campo">Loja (como o cliente conhece)
            <input type="text" maxlength="80" [value]="c.persona.loja" (input)="persona('loja', $any($event.target).value)" />
          </label>
          <label class="campo">Tom
            <select [value]="c.persona.tom" (change)="persona('tom', $any($event.target).value)">
              @for (t of tons; track t) { <option [value]="t">{{ t }}</option> }
            </select>
          </label>
          <label class="check"><input type="checkbox" [checked]="c.persona.usaEmojis" (change)="persona('usaEmojis', $any($event.target).checked)" /> Pode usar emojis com moderação</label>
        </div>
        <label class="campo">Saudação sugerida
          <input type="text" maxlength="300" [value]="c.persona.saudacao" (input)="persona('saudacao', $any($event.target).value)" />
        </label>
        @if (erroPrefixo('persona'); as e) { <p class="erro" role="alert">{{ e }}</p> }
      </section>

      <!-- Roteiro de qualificação -->
      <section class="secao" id="pb-qualificacao">
        <h3 class="txt-secao">Roteiro de qualificação</h3>
        <p class="dica">Nesta ordem, uma pergunta por vez; o agente pula o que já sabe. Inativo fica guardado mas não é perguntado.</p>
        @if (c.qualificacao.length === 0) { <p class="dica">Nenhuma pergunta no roteiro.</p> }
        <ol class="roteiro">
          @for (q of c.qualificacao; track q.slot; let i = $index, primeiro = $first, ultimo = $last) {
            <li class="item" [class.inativo]="!q.ativo">
              <div class="item-topo">
                <span class="txt-rotulo">{{ i + 1 }}. {{ rotuloSlot(q.slot) }}</span>
                <span class="acoes-item">
                  <label class="check"><input type="checkbox" [checked]="q.ativo" (change)="item(i, { ativo: $any($event.target).checked })" /> ativo</label>
                  <label class="check"><input type="checkbox" [checked]="q.obrigatorio" (change)="item(i, { obrigatorio: $any($event.target).checked })" /> obrigatório</label>
                  <button type="button" class="icone" [disabled]="primeiro" (click)="mover(i, -1)" [attr.aria-label]="'Subir ' + rotuloSlot(q.slot)">↑</button>
                  <button type="button" class="icone" [disabled]="ultimo" (click)="mover(i, 1)" [attr.aria-label]="'Descer ' + rotuloSlot(q.slot)">↓</button>
                  <button type="button" class="icone" (click)="remover(i)" [attr.aria-label]="'Remover ' + rotuloSlot(q.slot)">✕</button>
                </span>
              </div>
              <label class="campo">Como perguntar
                <input type="text" [attr.maxlength]="lim.pergunta" [value]="q.pergunta" (input)="item(i, { pergunta: $any($event.target).value })" />
              </label>
              @if (erroPrefixo('qualificacao[' + i + ']'); as e) { <p class="erro" role="alert">{{ e }}</p> }
            </li>
          }
        </ol>
        @if (editavel() && livres().length > 0) {
          <div class="adicionar">
            <label class="campo">Adicionar ao roteiro
              <select #novoSlot>
                @for (s of livres(); track s) { <option [value]="s">{{ rotuloSlot(s) }}</option> }
              </select>
            </label>
            <ui-botao variante="secundario" (click)="adicionarSlot(novoSlot.value)">Adicionar</ui-botao>
          </div>
        }
      </section>

      <!-- Mensagens prontas -->
      <section class="secao" id="pb-mensagens">
        <h3 class="txt-secao">Mensagens prontas</h3>
        <p class="dica">Marcadores: @for (p of placeholders; track p) { <code class="txt-dados">{{ p }}</code> } — vazio = o texto padrão do sistema.
          A identificação como assistente virtual e o aviso de privacidade são SEMPRE acrescentados pelo sistema à abertura.
          Sem valor em reais, percentual ou prazo.</p>
        @for (k of mensagens; track k) {
          <label class="campo">{{ rotuloMensagem(k) }}
            <textarea rows="2" [attr.maxlength]="lim.mensagem" [value]="c.mensagens[k] ?? ''" (input)="mensagem(k, $any($event.target).value)"
                      placeholder="(texto padrão do sistema)"></textarea>
          </label>
          @if (erro('mensagens.' + k); as e) { <p class="erro" role="alert">{{ e }}</p> }
        }
      </section>

      <!-- Compliance extra -->
      <section class="secao" id="pb-compliance">
        <h3 class="txt-secao">Compliance extra</h3>
        <p class="dica">Só acrescenta: frases que o agente nunca diz e palavras do cliente que chamam uma pessoa. Texto literal, sem acento/caixa.</p>
        <div class="duas">
          <div class="encolhe">
            @for (l of listas; track l.id) {
              <p class="txt-rotulo">{{ l.rotulo }}</p>
              <div class="chips">
                @for (f of c.compliance[l.id]; track f) {
                  <span class="chip">{{ f }}
                    @if (editavel()) { <button type="button" class="x" (click)="tirarChip(l.id, f)" [attr.aria-label]="'Remover ' + f">✕</button> }
                  </span>
                }
                @if (c.compliance[l.id].length === 0) { <span class="dica">nenhuma</span> }
              </div>
              @if (editavel()) {
                <form class="adicionar" (submit)="$event.preventDefault(); botarChip(l.id, campoChip.value); campoChip.value = ''">
                  <label class="campo">Acrescentar
                    <input #campoChip type="text" maxlength="80" />
                  </label>
                  <ui-botao tipo="submit" variante="secundario">Acrescentar</ui-botao>
                </form>
              }
              @if (erroChip()[l.id]; as e) { <p class="erro" role="alert">{{ e }}</p> }
              @if (erroPrefixo('compliance.' + l.id); as e) { <p class="erro" role="alert">{{ e }}</p> }
            }
          </div>
          <aside class="leitura encolhe" aria-label="Sempre valem">
            <p class="txt-rotulo">Sempre valem — não se desligam pela tela</p>
            <ul>
              @for (b of base().frasesBase; track b.id) { <li>{{ b.rotulo }}</li> }
            </ul>
            @if (complianceDoNumero(); as cn) {
              @if (cn.frasesProibidas.length || cn.gatilhosHandoff.length) {
                <p class="txt-rotulo">Do número (aba Proteções)</p>
                <ul>
                  @for (f of cn.frasesProibidas; track f) { <li>nunca diz: {{ f }}</li> }
                  @for (g of cn.gatilhosHandoff; track g) { <li>chama pessoa: {{ g }}</li> }
                </ul>
              }
            }
          </aside>
        </div>
      </section>

      <!-- Ações -->
      <section class="secao" id="pb-acoes">
        <h3 class="txt-secao">Ações permitidas</h3>
        <ul class="toggles">
          @for (a of base().acoes; track a.id) {
            <li>
              <label class="check"><input type="checkbox" [checked]="c.acoes[a.id]" (change)="acao(a.id, $any($event.target).checked)" />
                <span><strong>{{ a.rotulo }}</strong><br /><span class="dica">{{ a.descricao }}</span></span></label>
            </li>
          }
        </ul>
        @if (erroPrefixo('acoes'); as e) { <p class="erro" role="alert">{{ e }}</p> }
        <p class="txt-rotulo">Sempre ligadas — não se desligam pela tela</p>
        <div class="chips">
          @for (s of base().sempreLigadas; track s.id) { <ui-badge>{{ s.rotulo }}</ui-badge> }
        </div>
      </section>
    </fieldset>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .secoes { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--espacamento-4); }
    .secao { border: 1px solid var(--borda); border-radius: var(--raio-painel); padding: var(--espacamento-4); background: var(--superficie-elevada);
      display: flex; flex-direction: column; gap: var(--espacamento-2); min-width: 0; }
    h3 { margin: 0; }
    .dica { margin: 0; color: var(--texto-suave); font-size: 12px; }
    .erro { margin: 0; color: var(--erro); font-size: 12px; }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: var(--espacamento-3); align-items: end; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 13px; color: var(--texto-secundario); min-width: 0; position: relative; }
    input[type=text], input[type=number], select, textarea { font: inherit; color: var(--texto); background: var(--superficie);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); padding: var(--espacamento-1) var(--espacamento-2);
      min-height: var(--densidade-alvo-clique-console); min-width: 0; width: 100%; }
    textarea { resize: vertical; }
    input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .contador { align-self: flex-end; color: var(--texto-suave); font-size: 11px; }
    .check { display: inline-flex; gap: var(--espacamento-2); align-items: flex-start; font-size: 13px; color: var(--texto); }
    .roteiro { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .item { border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: var(--espacamento-2) var(--espacamento-3); background: var(--superficie);
      display: flex; flex-direction: column; gap: var(--espacamento-1); }
    .item.inativo { opacity: 0.7; }
    .item-topo { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .acoes-item { display: inline-flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .icone { font: inherit; min-width: 32px; min-height: 32px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie-elevada); color: var(--texto); cursor: pointer; }
    .icone:disabled { opacity: 0.4; cursor: default; }
    .adicionar { display: flex; gap: var(--espacamento-2); align-items: end; flex-wrap: wrap; }
    .adicionar .campo { flex: 1; min-width: 160px; }
    .duas { display: grid; grid-template-columns: 1fr minmax(200px, 0.8fr); gap: var(--espacamento-4); }
    .chips { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-1); padding: 2px var(--espacamento-2); border-radius: var(--raio-completo);
      background: var(--acao-suave); color: var(--texto); font-size: 13px; overflow-wrap: anywhere; }
    .x { border: 0; background: transparent; color: var(--texto-secundario); cursor: pointer; font: inherit; }
    .leitura { border-left: 2px solid var(--borda); padding-left: var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); }
    .leitura ul { margin: var(--espacamento-1) 0 var(--espacamento-2); padding-left: var(--espacamento-4); }
    .toggles { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: var(--espacamento-2); }
    code { font-size: 12px; background: var(--fundo); padding: 0 var(--espacamento-1); border-radius: var(--raio-controle); margin-right: var(--espacamento-1); }
    @media (max-width: 640px) {
      .duas { grid-template-columns: 1fr; }
      .leitura { border-left: 0; padding-left: 0; border-top: 1px solid var(--borda); padding-top: var(--espacamento-2); }
      .secao { padding: var(--espacamento-3); }
    }
  `,
})
export class PlaybookEditorComponente {
  readonly conteudo = input.required<ConteudoPlaybook>()
  readonly editavel = input(false)
  readonly erros = input<Readonly<Record<string, string>>>({})
  readonly base = input.required<Base>()
  readonly complianceDoNumero = input<ComplianceExtra | null>(null)
  readonly mudou = output<ConteudoPlaybook>()

  readonly lim = LIMITES_PLAYBOOK
  readonly tons = TONS
  readonly mensagens = MENSAGENS_PLAYBOOK
  readonly placeholders = PLACEHOLDERS_PLAYBOOK
  readonly listas: readonly { id: Lista; rotulo: string }[] = [
    { id: 'frasesProibidas', rotulo: 'Frases que o agente nunca diz' },
    { id: 'gatilhosHandoff', rotulo: 'Se o cliente disser, chama uma pessoa' },
  ]
  readonly erroChip = signal<Partial<Record<Lista, string>>>({})
  readonly livres = computed(() => slotsLivres(this.conteudo().qualificacao))

  rotuloSlot(s: SlotQualificacao): string { return ROTULO_SLOT[s] }
  rotuloMensagem(k: ChaveMensagemPlaybook): string { return ROTULO_MENSAGEM[k] }
  num(v: string): number | null { return numeroOuNulo(v) }
  erro(campo: string): string | null { return this.erros()[campo] ?? null }
  erroPrefixo(p: string): string | null { return erroDoPrefixo(this.erros(), p) }

  private emitir(fn: (c: ConteudoPlaybook) => ConteudoPlaybook): void {
    if (!this.editavel()) return
    this.mudou.emit(fn(this.conteudo()))
  }

  estilo<K extends keyof ConteudoPlaybook['estilo']>(k: K, v: ConteudoPlaybook['estilo'][K]): void {
    this.emitir((c) => ({ ...c, estilo: { ...c.estilo, [k]: v } }))
  }
  persona<K extends keyof ConteudoPlaybook['persona']>(k: K, v: ConteudoPlaybook['persona'][K]): void {
    this.emitir((c) => ({ ...c, persona: { ...c.persona, [k]: v } }))
  }
  item(i: number, p: Partial<ItemQualificacao>): void {
    this.emitir((c) => ({ ...c, qualificacao: c.qualificacao.map((q, j) => (j === i ? { ...q, ...p } : q)) }))
  }
  mover(i: number, d: -1 | 1): void { this.emitir((c) => ({ ...c, qualificacao: [...moverItem(c.qualificacao, i, d)] })) }
  remover(i: number): void { this.emitir((c) => ({ ...c, qualificacao: c.qualificacao.filter((_q, j) => j !== i) })) }
  adicionarSlot(s: string): void {
    const slot = s as SlotQualificacao
    this.emitir((c) => ({ ...c, qualificacao: [...c.qualificacao, { slot, pergunta: '', obrigatorio: false, ativo: true }] }))
  }
  mensagem(k: ChaveMensagemPlaybook, v: string): void {
    this.emitir((c) => ({ ...c, mensagens: { ...c.mensagens, [k]: v.trim() ? v : null } }))
  }
  botarChip(l: Lista, v: string): void {
    const r = adicionarChip(this.conteudo().compliance[l], v, LIMITES_COMPLIANCE.maxItens)
    this.erroChip.update((e) => ({ ...e, [l]: r.erro ?? undefined }))
    if (!r.erro) this.emitir((c) => ({ ...c, compliance: { ...c.compliance, [l]: [...r.lista] } }))
  }
  tirarChip(l: Lista, v: string): void {
    this.emitir((c) => ({ ...c, compliance: { ...c.compliance, [l]: c.compliance[l].filter((x) => x !== v) } }))
  }
  acao(a: AcaoPlaybook, v: boolean): void {
    this.emitir((c) => ({ ...c, acoes: { ...c.acoes, [a]: v } }))
  }
}
