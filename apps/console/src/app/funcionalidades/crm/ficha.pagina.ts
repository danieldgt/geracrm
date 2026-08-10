import { Component, ChangeDetectionStrategy, inject, input, effect, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { FichaServico, type FichaContato } from './ficha.servico.js'

/**
 * Ficha do Contato — o cliente 360°.
 *
 * ⚠️ Cada bloco tem seu próprio estado (dados, RFV, vendas, categorias,
 * comentários). Bloco sem dado mostra o porquê — cliente sem venda, itens de
 * venda não importados — em vez de sumir ou aparecer vazio como se fosse bug.
 *
 * O `id` vem da rota (component input binding). Recarrega quando muda.
 */
@Component({
  selector: 'app-ficha-contato',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <a routerLink="/contatos" class="voltar">← Contatos</a>

    @switch (servico.estado()) {
      @case ('carregando') { <div class="bloco" aria-busy="true"><div class="esqueleto"></div></div> }
      @case ('nao_encontrado') { <div class="bloco aviso"><h2>Contato não encontrado</h2>
        <p>Ele pode ter sido mesclado ou removido.</p></div> }
      @case ('sem_permissao') { <div class="bloco aviso"><h2>Sem acesso a este contato</h2></div> }
      @case ('erro') { <div class="bloco aviso"><h2>Não foi possível carregar</h2>
        <p>{{ servico.erro() }}</p></div> }
      @case ('pronto') {
        @if (servico.ficha(); as f) {
          <div class="grade">
            <!-- Coluna esquerda: identidade -->
            <section class="col">
              <div class="cartao cabecalho">
                @if (editandoNome()) {
                  <form class="edit-nome" (submit)="salvarNome($event)">
                    <input [value]="rascunhoNome()" (input)="rascunhoNome.set($any($event.target).value)" aria-label="Nome" />
                    <button class="mini-btn primario" type="submit">Salvar</button>
                    <button class="mini-btn" type="button" (click)="editandoNome.set(false)">Cancelar</button>
                  </form>
                } @else {
                  <h1>{{ f.nome }} <button class="lapis" (click)="abrirNome(f.nome)" title="Editar nome">✎</button></h1>
                }
                @if (servico.erroEdicao(); as e) { <p class="erro-edit" role="alert">{{ e }}</p> }
                <div class="tags">
                  @if (f.modalidade) { <span class="tag">{{ f.modalidade }}</span> }
                  @if (f.qualificado) { <span class="tag ok">Qualificado</span> }
                  @if (f.metricas; as m) {
                    <span class="tag rfv" [style.--c]="cor(m.segmento.codigo)">{{ m.segmento.rotulo }}</span>
                  }
                </div>
              </div>

              <div class="cartao">
                <h3>Contato</h3>
                @if (f.telefones.length) {
                  <ul class="linhas">
                    @for (t of f.telefones; track t.seq) {
                      <li>
                        <span class="mono encolhe">{{ t.e164 }}</span>
                        @if (t.principal) { <span class="mini">principal</span> }
                        @else { <button class="mini-btn" (click)="servico.principalTelefone(t.seq)">tornar principal</button> }
                        @if (t.whatsapp) { <span class="mini wpp">WhatsApp</span> }
                        <button class="x" (click)="servico.removerTelefone(t.seq)" title="Remover">×</button>
                      </li>
                    }
                  </ul>
                } @else { <p class="vazio-mini">Sem telefone cadastrado.</p> }
                <form class="add-linha" (submit)="salvarTelefone($event)">
                  <input [value]="novoTel()" (input)="novoTel.set($any($event.target).value)" placeholder="Novo telefone" inputmode="tel" />
                  <button class="mini-btn" type="submit" [disabled]="!novoTel().trim()">+ telefone</button>
                </form>

                <h3>Documentos</h3>
                @if (f.documentos.length) {
                  <ul class="linhas">
                    @for (d of f.documentos; track d.seq) {
                      <li><span class="mono encolhe">{{ d.numero }}</span> <span class="mini">{{ d.tipo }}</span>
                        <button class="x" (click)="servico.removerDocumento(d.seq)" title="Remover">×</button></li>
                    }
                  </ul>
                  @if (f.totalDocumentos > f.documentos.length) {
                    <p class="alerta-mini">⚠️ {{ f.totalDocumentos }} documentos neste contato —
                       provável fusão de cadastros por telefone repetido.</p>
                  }
                } @else { <p class="vazio-mini">Sem documento.</p> }
                <form class="add-linha" (submit)="salvarDocumento($event)">
                  <select [value]="novoDocTipo()" (change)="novoDocTipo.set($any($event.target).value)">
                    <option value="cnpj">CNPJ</option><option value="cpf">CPF</option>
                  </select>
                  <input [value]="novoDoc()" (input)="novoDoc.set($any($event.target).value)" placeholder="Número" inputmode="numeric" />
                  <button class="mini-btn" type="submit" [disabled]="!novoDoc().trim()">+ documento</button>
                </form>

                @if (f.endereco; as e) {
                  <h3>Endereço</h3>
                  <p class="endereco">{{ enderecoTexto(e) }}</p>
                }
              </div>
            </section>

            <!-- Coluna direita: comportamento -->
            <section class="col">
              <div class="cartao">
                <h3>Informações de vendas</h3>
                @if (f.metricas; as m) {
                  <dl class="metricas">
                    <div><dt>Total em vendas</dt><dd class="mono forte">{{ reais(m.totalCentavos) }}</dd></div>
                    <div><dt>Compras</dt><dd class="mono">{{ m.qtdVendas }}</dd></div>
                    <div><dt>Ticket médio</dt><dd class="mono">{{ m.ticketMedioCentavos !== null ? reais(m.ticketMedioCentavos) : '—' }}</dd></div>
                    <div><dt>Dias sem comprar</dt><dd class="mono">{{ m.diasSemComprar ?? '—' }}</dd></div>
                    <div><dt>Ritmo (média entre compras)</dt><dd class="mono">{{ m.mediaEntreVendasDias !== null ? (arred(m.mediaEntreVendasDias) + ' dias') : '—' }}</dd></div>
                    <div><dt>Perfil RFV</dt><dd>
                      <span class="tag rfv" [style.--c]="cor(m.segmento.codigo)">{{ m.segmento.rotulo }}</span>
                      @if (!m.confiavel) { <span class="mini" title="Histórico anterior à carga">estimado</span> }
                    </dd></div>
                  </dl>
                  <p class="acao-rfv">➜ {{ m.segmento.acao }}</p>
                } @else {
                  <p class="vazio-mini">Este contato ainda não tem vendas importadas — sem RFV por enquanto.</p>
                }
              </div>

              <div class="cartao">
                <h3>Categorias mais compradas</h3>
                @if (f.categorias.length) {
                  <ul class="barras">
                    @for (c of f.categorias; track c.categoria) {
                      <li>
                        <span class="rot">{{ c.categoria }}</span>
                        <span class="barra"><i [style.width.%]="pct(c.totalCentavos, f.categorias[0]?.totalCentavos ?? 1)"></i></span>
                        <span class="mono mini">{{ reais(c.totalCentavos) }}</span>
                      </li>
                    }
                  </ul>
                } @else {
                  <!-- Honesto: itens de venda vêm do detalhe /vendas/{id}, ainda não importado. -->
                  <p class="vazio-mini">Sem itens de venda importados — as categorias aparecem quando o
                     detalhe das vendas for sincronizado.</p>
                }
              </div>

              <div class="cartao">
                <h3>Últimas compras</h3>
                @if (f.ultimasVendas.length) {
                  <ul class="linhas">
                    @for (v of f.ultimasVendas; track v.id) {
                      <li [class.cancelada]="v.cancelada">
                        <span class="mono">{{ data(v.ocorridaEm) }}</span>
                        <span class="mono val">{{ reais(v.valorCentavos) }}</span>
                        @if (v.cancelada) { <span class="mini can">cancelada</span> }
                      </li>
                    }
                  </ul>
                } @else { <p class="vazio-mini">Sem compras registradas.</p> }
              </div>

              <div class="cartao">
                <h3>Comentários</h3>
                @if (f.comentarios.length) {
                  <ul class="coment">
                    @for (c of f.comentarios; track c.id) {
                      <li><span class="mini">{{ data(c.criadoEm) }}</span><p>{{ c.texto }}</p></li>
                    }
                  </ul>
                } @else { <p class="vazio-mini">Nenhum comentário ainda.</p> }
                <form class="add-coment" (submit)="salvarComentario($event)">
                  <input [value]="novoComent()" (input)="novoComent.set($any($event.target).value)" placeholder="Anotar algo sobre o cliente…" />
                  <button class="mini-btn" type="submit" [disabled]="!novoComent().trim()">Anotar</button>
                </form>
              </div>
            </section>
          </div>
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 1040px; padding: var(--espacamento-6); }
    .lapis { border: 0; background: transparent; color: var(--texto-suave); cursor: pointer; font-size: 14px; }
    .lapis:hover { color: var(--acao); }
    .edit-nome { display: flex; gap: var(--espacamento-2); align-items: center; }
    .edit-nome input { flex: 1; padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .erro-edit { color: var(--erro); font-size: 12px; margin: var(--espacamento-1) 0 0; }
    .mini-btn { padding: 2px 8px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 11px; cursor: pointer; }
    .mini-btn.primario { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .mini-btn:disabled { opacity: .5; cursor: default; }
    .x { border: 0; background: transparent; color: var(--texto-suave); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; }
    .x:hover { color: var(--erro); }
    .add-linha, .add-coment { display: flex; gap: var(--espacamento-2); margin-top: var(--espacamento-2); }
    .add-linha input, .add-coment input, .add-linha select { flex: 1; padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; font-size: 13px; }
    .add-linha select { flex: 0 0 auto; }
    .voltar { display: inline-block; margin-bottom: var(--espacamento-4); color: var(--acao); text-decoration: none; font-size: 13px; }
    .voltar:hover { text-decoration: underline; }
    .grade { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(340px, 1.4fr); gap: var(--espacamento-4); align-items: start; }
    .col { display: grid; gap: var(--espacamento-4); }
    .cartao { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .cartao h3 { margin: var(--espacamento-3) 0 var(--espacamento-2); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); }
    .cartao h3:first-child { margin-top: 0; }
    .cabecalho h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .tags { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); margin-top: var(--espacamento-2); }
    .tag { font-size: 12px; padding: 1px var(--espacamento-2); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto-secundario); border: 1px solid var(--borda); }
    .tag.ok { color: var(--sucesso); border-color: var(--sucesso); }
    .tag.rfv { color: var(--c); border-color: var(--c); font-weight: 600; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .aviso { text-align: center; } .aviso h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; }
    .esqueleto { height: 200px; background: var(--superficie); border-radius: var(--raio-controle); }
    .linhas { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-1); }
    .linhas li { display: flex; align-items: center; gap: var(--espacamento-2); font-size: 13px; color: var(--texto); }
    .linhas li.cancelada { color: var(--texto-suave); text-decoration: line-through; }
    .val { margin-left: auto; }
    .mono { font-family: var(--tipografia-familia-dados); font-variant-numeric: tabular-nums; }
    .forte { font-size: 16px; font-weight: 600; color: var(--texto); }
    .mini { font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: var(--texto-suave); border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: 0 4px; }
    .mini.wpp { color: var(--sucesso); border-color: var(--sucesso); }
    .mini.can { color: var(--erro); border-color: var(--erro); }
    .vazio-mini { font-size: 13px; color: var(--texto-suave); margin: 0; }
    .alerta-mini { font-size: 12px; color: var(--atencao); margin: var(--espacamento-2) 0 0; }
    .endereco { font-size: 13px; color: var(--texto-secundario); margin: 0; }
    .metricas { display: grid; grid-template-columns: 1fr 1fr; gap: var(--espacamento-3); margin: 0; }
    .metricas dt { font-size: 11px; color: var(--texto-suave); }
    .metricas dd { margin: 2px 0 0; font-size: 14px; color: var(--texto); }
    .acao-rfv { margin: var(--espacamento-3) 0 0; font-size: 13px; font-weight: 500; color: var(--acao); }
    .barras { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .barras li { display: grid; grid-template-columns: 110px 1fr auto; align-items: center; gap: var(--espacamento-2); font-size: 12px; }
    .rot { color: var(--texto-secundario); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .barra { height: 8px; background: var(--superficie); border-radius: var(--raio-completo); overflow: hidden; }
    .barra i { display: block; height: 100%; background: var(--acao); }
    .coment { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .coment p { margin: 2px 0 0; font-size: 13px; color: var(--texto); }
    @media (max-width: 760px) { .grade { grid-template-columns: 1fr; } }
  `,
})
export class FichaContatoPagina {
  readonly servico = inject(FichaServico)
  readonly id = input.required<string>()

  constructor() {
    // ⚠️ `id` vem da rota (component input binding). effect recarrega ao mudar —
    //    navegar de um contato para outro troca o dado sem recriar o componente.
    effect(() => {
      const id = this.id()
      if (id) { this.servico.vincular(id); void this.servico.carregar(id) }
    })
  }

  // Edição
  readonly editandoNome = signal(false)
  readonly rascunhoNome = signal('')
  readonly novoTel = signal('')
  readonly novoDoc = signal('')
  readonly novoDocTipo = signal<'cnpj' | 'cpf'>('cnpj')
  readonly novoComent = signal('')

  abrirNome(atual: string): void { this.rascunhoNome.set(atual); this.editandoNome.set(true) }
  async salvarNome(ev: Event): Promise<void> {
    ev.preventDefault()
    const nome = this.rascunhoNome().trim()
    if (nome && await this.servico.editarNome(nome)) this.editandoNome.set(false)
  }
  async salvarTelefone(ev: Event): Promise<void> {
    ev.preventDefault()
    const t = this.novoTel().trim()
    if (t && await this.servico.addTelefone(t)) this.novoTel.set('')
  }
  async salvarDocumento(ev: Event): Promise<void> {
    ev.preventDefault()
    const d = this.novoDoc().trim()
    if (d && await this.servico.addDocumento(this.novoDocTipo(), d)) this.novoDoc.set('')
  }
  async salvarComentario(ev: Event): Promise<void> {
    ev.preventDefault()
    const c = this.novoComent().trim()
    if (c && await this.servico.addComentario(c)) this.novoComent.set('')
  }

  cor(codigo: string): string { return `var(--rfv-${codigo})` }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  arred(n: number): number { return Math.round(n) }
  pct(v: number, max: number): number { return max > 0 ? Math.round((v / max) * 100) : 0 }
  data(iso: string): string { return new Date(iso).toLocaleDateString('pt-BR') }
  enderecoTexto(e: NonNullable<FichaContato['endereco']>): string {
    return [
      [e.logradouro, e.numero].filter(Boolean).join(', '),
      e.bairro, [e.cidade, e.uf].filter(Boolean).join('/'), e.cep,
    ].filter(Boolean).join(' · ')
  }
}
