import { Component, ChangeDetectionStrategy, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import {
  BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, QualidadeComponente, ToastServico,
  alternarCodigo, codigosParaSalvar, ehStatus, linhaDeCusto, mudouPermissao, permitidosDe, rotuloProvedor,
  type ModeloComPermissao,
} from '../../compartilhado/ui/index.js'
import { ModelosIaServico } from './modelos-ia.servico.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

/**
 * Painel inline (Plataforma → Clientes): quais modelos do catálogo ESTE cliente
 * pode escolher na tela do agente (docs/estudo-modelos-llm.md §3).
 *
 * ⚠️ "Voltar ao padrão do catálogo" NÃO é "desmarcar tudo": manda `[]` e a API
 * apaga as regras do cliente — ele passa a ver o que estiver marcado como
 * padrão, inclusive modelos que entrarem no catálogo depois. Salvar com caixas
 * marcadas congela o conjunto: modelo novo não entra sozinho.
 */
@Component({
  selector: 'app-modelos-cliente',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, QualidadeComponente],
  template: `
    <section class="painel" [attr.aria-label]="'Modelos de IA de ' + clienteNome()">
      <header class="cab">
        <h3 class="txt-corpo titulo encolhe">Modelos de IA — {{ clienteNome() }}</h3>
        <ui-botao variante="fantasma" (click)="fechar.emit()">Fechar</ui-botao>
      </header>

      @switch (estado()) {
        @case ('carregando') {
          <div class="esq" aria-busy="true">
            <ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" />
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Só o staff libera modelos"
            descricao="Seu usuário não está no grupo que administra clientes." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o catálogo"
            descricao="O servidor não respondeu. Dá para tentar de novo.">
            <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
          </ui-estado>
        }
        @case ('pronto') {
          @if (itens().length === 0) {
            <ui-estado titulo="Catálogo sem modelos" icone="🧩"
              descricao="Nenhum modelo ativo no catálogo global. A engenharia cadastra em modelo_ia (migration 0093)." />
          } @else {
            <p class="dica">Marcados aparecem para o cliente na tela do agente. Sem regra salva, ele vê os marcados como
              <strong>padrão</strong>. A chave de cada fornecedor é nossa — o cliente nunca a vê.</p>

            <ul class="lista" role="group" aria-label="Modelos liberados para este cliente">
              @for (m of itens(); track m.codigo) {
                <li class="item" [class.off]="!m.disponivel">
                  <label class="cx">
                    <input type="checkbox" [checked]="marcados().has(m.codigo)"
                           (change)="alternar(m.codigo, $any($event.target).checked)" [disabled]="salvando()" />
                    <span class="corpo encolhe">
                      <span class="linha">
                        <span class="nome encolhe">{{ m.nome }}</span>
                        <ui-badge [tom]="m.gratuito ? 'sucesso' : 'neutro'">{{ m.gratuito ? 'Grátis' : 'Pago' }}</ui-badge>
                        @if (m.padrao) { <ui-badge tom="info">padrão</ui-badge> }
                        @if (!m.disponivel) { <ui-badge tom="atencao">indisponível</ui-badge> }
                      </span>
                      <span class="meta">
                        <span>{{ provedor(m.provedor) }}</span>
                        <ui-qualidade [valor]="m.qualidade" />
                        @if (custo(m); as c) { <span class="txt-dados">{{ c }}</span> }
                      </span>
                      <!-- ⚠️ Indisponível NOMEIA a variável: é o staff quem resolve. -->
                      @if (!m.disponivel && m.motivoIndisponivel) {
                        <span class="motivo">Sem chave no servidor: <span class="txt-dados">{{ m.motivoIndisponivel }}</span>.
                          Liberar agora deixa o cliente ver um modelo que não responde.</span>
                      }
                    </span>
                  </label>
                </li>
              }
            </ul>

            @if (erroSalvar(); as e) { <p class="erro" role="alert">{{ e }}</p> }

            <div class="acoes">
              <ui-botao (click)="salvar()" [desabilitado]="!mudou()" [carregando]="salvando() === 'salvar'">
                {{ salvando() === 'salvar' ? 'Salvando…' : 'Salvar' }}</ui-botao>
              <ui-botao variante="secundario" (click)="voltarAoPadrao()" [carregando]="salvando() === 'padrao'"
                        [desabilitado]="salvando() === 'salvar'">
                {{ salvando() === 'padrao' ? 'Voltando…' : 'Voltar ao padrão do catálogo' }}</ui-botao>
              <span class="contagem txt-dados">{{ marcados().size }} de {{ itens().length }} liberados</span>
            </div>
          }
        }
      }
    </section>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .painel { display: grid; gap: var(--espacamento-3); padding: var(--espacamento-3); border-top: 1px solid var(--borda);
      background: var(--superficie); border-radius: 0 0 var(--raio-controle) var(--raio-controle); min-width: 0; }
    .cab { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); min-width: 0; }
    .titulo { margin: 0; color: var(--texto); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .esq { display: grid; gap: var(--espacamento-2); }
    .dica { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .item { border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie-elevada); min-width: 0; }
    .item.off { opacity: .7; }
    .cx { display: flex; align-items: flex-start; gap: var(--espacamento-2); padding: var(--espacamento-2) var(--espacamento-3);
      cursor: pointer; min-width: 0; }
    .cx:has(input:focus-visible) { outline: 2px solid var(--borda-foco); outline-offset: -2px; border-radius: var(--raio-controle); }
    .cx input { margin-top: 3px; flex: none; }
    .corpo { display: grid; gap: 2px; min-width: 0; }
    .linha { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .nome { color: var(--texto); font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; color: var(--texto-secundario); font-size: 12px; }
    .motivo { color: var(--atencao); font-size: 12px; overflow-wrap: anywhere; }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .contagem { color: var(--texto-suave); font-size: 12px; margin-left: auto; }
  `,
})
export class ModelosClienteComponente {
  readonly clienteId = input.required<string>()
  readonly clienteNome = input('')
  readonly fechar = output<void>()

  private readonly api = inject(ModelosIaServico)
  private readonly toast = inject(ToastServico)

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly ModeloComPermissao[]>([])
  /** O que está salvo (vem da API) — base para saber se algo mudou. */
  private readonly salvos = signal<ReadonlySet<string>>(new Set())
  readonly marcados = signal<ReadonlySet<string>>(new Set())
  readonly salvando = signal<'salvar' | 'padrao' | null>(null)
  /** ⚠️ Parcial: o catálogo está na tela; o PUT falhou. A lista não some. */
  readonly erroSalvar = signal<string | null>(null)

  readonly mudou = computed(() => mudouPermissao(this.salvos(), this.marcados()))

  constructor() {
    effect(() => { this.clienteId(); untracked(() => void this.carregar()) })
  }

  provedor(p: string): string { return rotuloProvedor(p) }
  custo(m: ModeloComPermissao): string | null { return linhaDeCusto(m) }

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.erroSalvar.set(null)
    try {
      const itens = await this.api.listar(this.clienteId())
      this.itens.set(itens)
      const p = permitidosDe(itens)
      this.salvos.set(p); this.marcados.set(p)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehStatus(e, 403) || ehStatus(e, 401) ? 'sem_permissao' : 'erro')
    }
  }

  alternar(codigo: string, ligado: boolean): void {
    this.marcados.update((s) => alternarCodigo(s, codigo, ligado))
    this.erroSalvar.set(null)
  }

  async salvar(): Promise<void> {
    if (this.salvando() || !this.mudou()) return
    await this.enviar('salvar', codigosParaSalvar(this.marcados(), this.itens()),
      (n) => `Salvo — ${n} modelo(s) liberado(s) para ${this.clienteNome() || 'o cliente'}.`)
  }

  async voltarAoPadrao(): Promise<void> {
    if (this.salvando()) return
    await this.enviar('padrao', [], () => `${this.clienteNome() || 'O cliente'} voltou ao padrão do catálogo.`)
  }

  private async enviar(acao: 'salvar' | 'padrao', codigos: string[], frase: (n: number) => string): Promise<void> {
    this.salvando.set(acao); this.erroSalvar.set(null)
    try {
      const r = await this.api.definir(this.clienteId(), codigos)
      if (r.ok) {
        this.toast.sucesso(frase(r.permitidos.length))
        await this.carregar()
        return
      }
      if (r.status === 403) { this.estado.set('sem_permissao'); return }
      this.erroSalvar.set(r.mensagem)
    } finally { this.salvando.set(null) }
  }
}
