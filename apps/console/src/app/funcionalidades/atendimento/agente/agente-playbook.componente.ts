import {
  Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked,
} from '@angular/core'
import { HttpErrorResponse } from '@angular/common/http'
import { diffPorSecao, type ConteudoPlaybook, type DiffSecaoPlaybook } from '@geracrm/shared'
import {
  BadgeComponente, BotaoComponente, ConfirmacaoServico, EsqueletoComponente, EstadoComponente, PainelComponente, ToastServico,
} from '../../../compartilhado/ui/index.js'
import { PlaybookServico, errosDaFalha, type EstadoPlaybookApi } from './playbook.servico.js'
import { PlaybookEditorComponente } from './playbook-editor.componente.js'
import { PlaybookDiffComponente } from './playbook-diff.componente.js'
import { PlaybookHistoricoComponente } from './playbook-historico.componente.js'
import { AgentePlaygroundComponente } from './agente-playground.componente.js'
import { ARQUIVO_MAX_BYTES, tipoArquivoDe } from './conhecimento.regras.js'
import { erroDaObservacao, errosPorCampo, temAlteracao, textoDaBarra, textoDaFalhaDoDocumento, textoDeFalha } from './playbook.regras.js'

/**
 * PLAYBOOK COMERCIAL (raia P17; ADR-029, ADR-033) — "como vender", versionado.
 *
 *   rascunho → Testar (sandbox seco) → Publicar (observação ≥ 10, admin) →
 *   versão imutável + auditoria → histórico, diff, restaurar.
 *
 * Por número ou padrão da conta. A tela só ACRESCENTA restrição: a base do
 * código e as ações de segurança aparecem só para leitura. "Atualizar a partir
 * de documento" gera só RASCUNHO (o LLM nunca publica).
 */
export const ABA_PLAYBOOK_PRONTA: boolean = true

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
type Painel = 'nenhum' | 'publicar' | 'documento'
type Vista = 'editar' | 'historico' | 'testar'

@Component({
  selector: 'app-agente-playbook',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PainelComponente, EstadoComponente, EsqueletoComponente, BotaoComponente, BadgeComponente,
    PlaybookEditorComponente, PlaybookDiffComponente, PlaybookHistoricoComponente, AgentePlaygroundComponente,
  ],
  template: `
    <div class="topo">
      <div class="escopo" role="group" aria-label="Qual playbook">
        <button type="button" [class.ativo]="escopo() === 'numero'" (click)="trocarEscopo('numero')">Este número</button>
        <button type="button" [class.ativo]="escopo() === 'tenant'" (click)="trocarEscopo('tenant')">Padrão da conta</button>
      </div>
      <p class="dica encolhe">{{ escopo() === 'tenant' ? 'Vale para todos os números sem playbook próprio.' : 'Vale só para o número selecionado.' }}</p>
    </div>

    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq"><ui-esqueleto altura="20px" largura="60%" /><ui-esqueleto altura="120px" /><ui-esqueleto altura="120px" /></div></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar o playbook" [descricao]="erroCarga() ?? 'Tente de novo em instantes.'" />
          <div class="centro"><ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao></div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Sem acesso ao playbook" descricao="Peça a um administrador." /></ui-painel>
      }
      @case ('pronto') {
        @if (dados(); as d) {
          <!-- Barra de versão -->
          <div class="barra">
            <div class="versao encolhe">
              <span>{{ barra() }}</span>
              @if (d.rascunho) {
                <ui-badge tom="atencao">rascunho aberto{{ d.rascunho.origem === 'documento' ? ' (sugerido de documento)' : '' }}</ui-badge>
              }
              @if (alterado()) { <ui-badge tom="info">alterações não salvas</ui-badge> }
            </div>
            @if (d.podeEditar) {
              <div class="botoes">
                @if (d.importavel) {
                  <ui-botao [carregando]="ocupado()" (click)="importar()">Importar da configuração atual</ui-botao>
                } @else if (!d.rascunho) {
                  <ui-botao [carregando]="ocupado()" (click)="editar()">Editar</ui-botao>
                  <ui-botao variante="secundario" [desabilitado]="!d.publicada && !(d.vigente)" (click)="abrirPainel('documento')">Atualizar a partir de documento</ui-botao>
                } @else {
                  <ui-botao variante="secundario" [desabilitado]="!alterado()" [carregando]="salvando()" (click)="salvar()">Salvar rascunho</ui-botao>
                  <ui-botao [desabilitado]="alterado()" (click)="abrirPainel('publicar')">Publicar…</ui-botao>
                  <ui-botao variante="perigo" (click)="descartar()">Descartar rascunho</ui-botao>
                }
              </div>
            }
          </div>
          @if (erroAcao(); as e) { <p class="erro" role="alert">{{ e }}</p> }
          @if (alterado()) { <p class="dica">Salve o rascunho antes de publicar ou testar — o sandbox roda o rascunho salvo.</p> }

          <!-- Publicar -->
          @if (painel() === 'publicar' && d.rascunho) {
            <ui-painel>
              <h3 class="txt-secao">Publicar o rascunho</h3>
              <p class="dica">Vira a versão em vigor na PRÓXIMA mensagem do agente{{ escopo() === 'tenant' ? ' em todos os números sem playbook próprio' : '' }}. A versão atual fica no histórico.</p>
              <p class="txt-rotulo">O que muda</p>
              <app-playbook-diff [diff]="diffDoRascunho()" vazio="Nenhuma diferença em relação à publicada." />
              <form class="publicar" (submit)="$event.preventDefault(); publicar()">
                <label class="campo">Observação (obrigatória — fica na auditoria)
                  <textarea rows="2" maxlength="500" [value]="observacao()" (input)="observacao.set($any($event.target).value)"
                            placeholder="Ex.: tirar promessa de frete grátis e limitar a 1 pergunta por mensagem."></textarea>
                </label>
                @if (observacao() && erroObservacao(); as e) { <p class="dica">{{ e }}</p> }
                <div class="botoes">
                  <ui-botao variante="secundario" (click)="painel.set('nenhum')">Cancelar</ui-botao>
                  <ui-botao tipo="submit" [desabilitado]="!!erroObservacao()" [carregando]="ocupado()">Publicar</ui-botao>
                </div>
              </form>
            </ui-painel>
          }

          <!-- A partir de documento -->
          @if (painel() === 'documento') {
            <ui-painel>
              <h3 class="txt-secao">Atualizar a partir de documento</h3>
              <p class="dica">Envie a política ou o roteiro novo (.txt, .md ou .pdf) ou cole o texto. A IA sugere um RASCUNHO com o resumo das mudanças — nada é publicado sem a sua revisão. Persona, limites e ações nunca mudam por aqui.</p>
              <label class="campo">Arquivo
                <input type="file" accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf" (change)="escolherArquivo($event)" />
              </label>
              <label class="campo">ou cole o texto
                <textarea rows="5" [value]="textoDoc()" (input)="textoDoc.set($any($event.target).value)"></textarea>
              </label>
              <div class="botoes">
                <ui-botao variante="secundario" (click)="painel.set('nenhum')">Cancelar</ui-botao>
                <ui-botao [carregando]="ocupado()" [desabilitado]="!arquivoDoc() && textoDoc().trim().length < 20" (click)="sugerir()">Gerar rascunho</ui-botao>
              </div>
            </ui-painel>
          }
          @if (sugestao(); as s) {
            <ui-painel>
              <h3 class="txt-secao">Rascunho sugerido</h3>
              <ul class="resumo">@for (m of s.resumo; track $index) { <li>{{ m }}</li> }</ul>
              <app-playbook-diff [diff]="s.diff" />
              <p class="dica">Revise nas seções abaixo, teste e publique — ou descarte o rascunho.</p>
            </ui-painel>
          }

          <!-- Vistas -->
          <div class="vistas" role="tablist">
            <button type="button" role="tab" [attr.aria-selected]="vista() === 'editar'" [class.ativo]="vista() === 'editar'" (click)="vista.set('editar')">Conteúdo</button>
            <button type="button" role="tab" [attr.aria-selected]="vista() === 'testar'" [class.ativo]="vista() === 'testar'" (click)="vista.set('testar')">Testar</button>
            <button type="button" role="tab" [attr.aria-selected]="vista() === 'historico'" [class.ativo]="vista() === 'historico'" (click)="vista.set('historico')">Histórico</button>
          </div>

          @switch (vista()) {
            @case ('editar') {
              @if (conteudoVisivel(); as c) {
                @if (d.rascunho && d.diff && !alterado()) {
                  <details class="diff-aberto"><summary>Diferenças do rascunho para a publicada</summary>
                    <app-playbook-diff [diff]="d.diff" vazio="O rascunho está igual à publicada." /></details>
                }
                @if (!d.rascunho) { <p class="dica">{{ d.podeEditar ? 'Somente leitura — clique em Editar para abrir um rascunho.' : 'Somente leitura.' }}</p> }
                <app-playbook-editor [conteudo]="c" [editavel]="d.podeEditar && !!d.rascunho" [erros]="erros()"
                  [base]="d.base" [complianceDoNumero]="d.complianceDoNumero" (mudou)="editado.set($event)" />
              } @else {
                <ui-painel><ui-estado titulo="Sem playbook ainda"
                  [descricao]="!d.podeEditar ? 'Peça a um administrador para criar o playbook.'
                    : d.importavel ? 'Importe a configuração atual do agente como versão 1 para começar.'
                    : 'Clique em Editar para começar.'" /></ui-painel>
              }
            }
            @case ('testar') {
              @if (escopo() === 'numero' || canalId()) {
                <app-agente-playground [canalId]="canalId()" playbook="rascunho" [escopoPlaybook]="escopo()"
                  [rascunhoDisponivel]="!!d.rascunho && !alterado()" />
              }
            }
            @case ('historico') {
              <app-playbook-historico [canalId]="canalEscopo()" [podeEditar]="d.podeEditar" [versaoDoPai]="revisao()" (restaurado)="carregar()" />
            }
          }
        }
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: var(--espacamento-4); min-width: 0; }
    .topo { display: flex; gap: var(--espacamento-3); align-items: center; flex-wrap: wrap; }
    .escopo, .vistas { display: inline-flex; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); overflow: hidden; }
    .escopo button, .vistas button { font: inherit; font-size: 13px; border: 0; background: var(--superficie); color: var(--texto-secundario);
      padding: var(--espacamento-1) var(--espacamento-3); min-height: var(--densidade-alvo-clique-console); cursor: pointer; }
    .escopo button.ativo, .vistas button.ativo { background: var(--superficie-selecionada); color: var(--acao); font-weight: 600; }
    .escopo button:focus-visible, .vistas button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; }
    .vistas { align-self: flex-start; }
    .dica { margin: 0; color: var(--texto-suave); font-size: 12px; }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .esq { display: flex; flex-direction: column; gap: var(--espacamento-3); }
    .centro { display: flex; justify-content: center; margin-top: var(--espacamento-3); }
    .barra { display: flex; justify-content: space-between; gap: var(--espacamento-3); align-items: center; flex-wrap: wrap;
      padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .versao { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; font-size: 14px; }
    .botoes { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    .publicar { display: flex; flex-direction: column; gap: var(--espacamento-2); margin-top: var(--espacamento-3); }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 13px; color: var(--texto-secundario); margin-top: var(--espacamento-2); }
    textarea, input[type=file] { font: inherit; color: var(--texto); background: var(--superficie); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); padding: var(--espacamento-1) var(--espacamento-2); min-width: 0; max-width: 100%; }
    textarea { resize: vertical; }
    h3 { margin: 0 0 var(--espacamento-2); }
    .resumo { margin: 0 0 var(--espacamento-3); padding-left: var(--espacamento-4); font-size: 13px; }
    .diff-aberto { border: 1px dashed var(--borda); border-radius: var(--raio-controle); padding: var(--espacamento-2) var(--espacamento-3); font-size: 13px; }
    .diff-aberto summary { cursor: pointer; color: var(--texto-secundario); margin-bottom: var(--espacamento-2); }
    @media (max-width: 640px) { .barra { padding: var(--espacamento-3); } }
  `,
})
export class AgentePlaybookComponente {
  /** Número selecionado na página (as seções do tenant inteiro ignoram). */
  readonly canalId = input.required<string>()

  private readonly api = inject(PlaybookServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  readonly escopo = signal<'numero' | 'tenant'>('numero')
  readonly estado = signal<Estado>('carregando')
  readonly erroCarga = signal<string | null>(null)
  readonly dados = signal<EstadoPlaybookApi | null>(null)
  /** O rascunho como está na tela (null = sem rascunho). */
  readonly editado = signal<ConteudoPlaybook | null>(null)
  readonly erros = signal<Readonly<Record<string, string>>>({})
  readonly erroAcao = signal<string | null>(null)
  readonly ocupado = signal(false)
  readonly salvando = signal(false)
  readonly painel = signal<Painel>('nenhum')
  readonly vista = signal<Vista>('editar')
  readonly observacao = signal('')
  readonly textoDoc = signal('')
  readonly arquivoDoc = signal<File | null>(null)
  readonly sugestao = signal<{ resumo: readonly string[]; diff: readonly DiffSecaoPlaybook[] } | null>(null)
  /** Muda a cada publicação/restauração: o histórico recarrega. */
  readonly revisao = signal(0)

  readonly canalEscopo = computed(() => (this.escopo() === 'numero' ? this.canalId() : null))
  readonly alterado = computed(() => temAlteracao(this.editado(), this.dados()?.rascunho?.conteudo ?? null))
  readonly conteudoVisivel = computed<ConteudoPlaybook | null>(() => {
    const d = this.dados()
    if (!d) return null
    if (d.rascunho) return this.editado() ?? d.rascunho.conteudo
    if (d.publicada) return d.publicada.conteudo
    return null
  })
  readonly barra = computed(() => {
    const d = this.dados()
    if (!d) return ''
    return textoDaBarra({ escopo: d.escopo, publicada: d.publicada, vigente: d.vigente, importavel: d.importavel })
  })
  readonly diffDoRascunho = computed(() => {
    const d = this.dados()
    const r = d?.rascunho
    if (!r) return []
    const ref = d.publicada?.conteudo ?? null
    return diffPorSecao(ref, this.editado() ?? r.conteudo)
  })
  readonly erroObservacao = computed(() => erroDaObservacao(this.observacao()))

  constructor() {
    effect(() => { this.canalId(); this.escopo(); untracked(() => void this.carregar()) })
  }

  async trocarEscopo(e: 'numero' | 'tenant'): Promise<void> {
    if (e === this.escopo()) return
    // ⚠️ Our own modal, never the browser confirm(): a native dialog blocks the
    //    tab and doesn't follow the theme.
    if (this.alterado()) {
      const ok = await this.confirmacao.confirmar({
        titulo: 'Trocar sem salvar o rascunho?',
        mensagem: 'Há alterações não salvas no rascunho deste escopo. Se trocar agora, elas se perdem.',
        acao: 'Trocar e descartar', cancelar: 'Continuar editando', perigo: true,
      })
      if (!ok) return
    }
    this.escopo.set(e)
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.erroAcao.set(null); this.erros.set({}); this.painel.set('nenhum')
    try {
      const d = await this.api.ler(this.canalEscopo())
      this.dados.set(d)
      this.editado.set(d.rascunho ? structuredClone(d.rascunho.conteudo) as ConteudoPlaybook : null)
      this.estado.set('pronto')
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) { this.estado.set('sem_permissao'); return }
      this.erroCarga.set(e instanceof HttpErrorResponse && e.status === 0 ? 'Servidor indisponível.' : null)
      this.estado.set('erro')
    }
  }

  abrirPainel(p: Painel): void { this.painel.set(this.painel() === p ? 'nenhum' : p); this.erroAcao.set(null) }

  private falhou(status: number, mensagem: string | undefined, contexto?: string): void {
    this.erroAcao.set(textoDeFalha(status, mensagem, contexto))
  }

  async importar(): Promise<void> {
    this.ocupado.set(true)
    try {
      const r = await this.api.importar(this.canalId())
      if (!r.ok) { this.falhou(r.status, r.erro.mensagem, 'importar'); return }
      this.toast.sucesso(r.importada ? 'Versão 1 importada da configuração atual.' : 'Este número já tinha playbook.')
      this.revisao.update((n) => n + 1)
      await this.carregar()
    } finally { this.ocupado.set(false) }
  }

  async editar(): Promise<void> {
    this.ocupado.set(true)
    try {
      const r = await this.api.criarRascunho(this.canalEscopo())
      if (!r.ok) { this.falhou(r.status, r.erro.mensagem, 'abrir o rascunho'); return }
      await this.carregar()
    } finally { this.ocupado.set(false) }
  }

  async salvar(): Promise<boolean> {
    const c = this.editado()
    if (!c) return false
    this.salvando.set(true); this.erroAcao.set(null)
    try {
      const r = await this.api.salvarRascunho(this.canalEscopo(), c)
      if (!r.ok) {
        const erros = errosDaFalha(r)
        this.erros.set(errosPorCampo(erros))
        this.falhou(r.status, r.erro.mensagem, 'salvar o rascunho')
        return false
      }
      this.erros.set({})
      this.dados.update((d) => (d ? { ...d, rascunho: r.versao, diff: diffPorSecao(d.publicada?.conteudo ?? null, r.versao.conteudo) } : d))
      this.editado.set(structuredClone(r.versao.conteudo) as ConteudoPlaybook)
      this.toast.sucesso('Rascunho salvo.')
      return true
    } finally { this.salvando.set(false) }
  }

  async descartar(): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: 'Descartar o rascunho?', mensagem: 'As alterações do rascunho se perdem. A versão publicada continua valendo.', acao: 'Descartar', perigo: true,
    })
    if (!ok) return
    const r = await this.api.descartarRascunho(this.canalEscopo())
    if (!r.ok) { this.falhou(r.status, r.erro.mensagem, 'descartar'); return }
    this.sugestao.set(null)
    this.toast.sucesso('Rascunho descartado.')
    await this.carregar()
  }

  async publicar(): Promise<void> {
    const rascunho = this.dados()?.rascunho
    if (this.erroObservacao() || this.ocupado() || !rascunho) return
    this.ocupado.set(true); this.erroAcao.set(null)
    try {
      // Publica o rascunho que a pessoa revisou: gravado depois por outra pessoa → 409, recarrega.
      const r = await this.api.publicar(this.canalEscopo(), this.observacao().trim(), rascunho.atualizadoEm)
      if (!r.ok) {
        this.erros.set(errosPorCampo(errosDaFalha(r)))
        this.falhou(r.status, r.erro.mensagem, 'publicar')
        // 409: o rascunho mudou depois que a pessoa revisou — recarrega para ela rever o diff.
        if (r.status === 409) {
          const aviso = this.erroAcao()
          await this.carregar()
          this.erroAcao.set(aviso)
        }
        return
      }
      this.toast.sucesso(`Publicado: v${r.versao.numero}${r.numerosAlcancados > 1 ? ` em ${r.numerosAlcancados} números` : ''}.`)
      this.observacao.set(''); this.sugestao.set(null); this.revisao.update((n) => n + 1)
      await this.carregar()
    } finally { this.ocupado.set(false) }
  }

  escolherArquivo(ev: Event): void {
    const f = (ev.target as HTMLInputElement).files?.[0] ?? null
    this.erroAcao.set(null)
    if (!f) { this.arquivoDoc.set(null); return }
    if (!tipoArquivoDe(f.name, f.type)) { this.erroAcao.set('Use um arquivo .txt, .md ou .pdf.'); this.arquivoDoc.set(null); return }
    if (f.size > ARQUIVO_MAX_BYTES) { this.erroAcao.set('O arquivo passa de 6 MB. Envie só a parte que muda a conduta.'); this.arquivoDoc.set(null); return }
    this.arquivoDoc.set(f)
  }

  async sugerir(): Promise<void> {
    this.ocupado.set(true); this.erroAcao.set(null)
    try {
      const f = this.arquivoDoc()
      const corpo = f
        ? { canalId: this.canalEscopo(), nome: f.name, tipo: tipoArquivoDe(f.name, f.type) ?? 'text/plain', conteudoBase64: await lerBase64(f) }
        : { canalId: this.canalEscopo(), texto: this.textoDoc().trim() }
      const r = await this.api.aPartirDeDocumento(corpo)
      if (!r.ok) {
        this.falhou(r.status, textoDaFalhaDoDocumento(r.erro.erro, r.erro.mensagem), 'gerar a sugestão')
        return
      }
      this.sugestao.set({ resumo: r.resumoMudancas, diff: r.diff })
      this.painel.set('nenhum'); this.textoDoc.set(''); this.arquivoDoc.set(null)
      this.toast.sucesso('Rascunho sugerido criado. Revise antes de publicar.')
      await this.carregar()
      this.sugestao.set({ resumo: r.resumoMudancas, diff: r.diff })
    } catch {
      this.erroAcao.set('Não foi possível ler o arquivo.')
    } finally { this.ocupado.set(false) }
  }
}

/** FileReader → base64 puro (sem o prefixo data:). */
function lerBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader()
    leitor.onload = () => resolve(String(leitor.result ?? '').replace(/^data:[^,]*,/, ''))
    leitor.onerror = () => reject(leitor.error ?? new Error('leitura falhou'))
    leitor.readAsDataURL(arquivo)
  })
}
