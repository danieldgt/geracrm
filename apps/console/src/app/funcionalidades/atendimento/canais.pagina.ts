import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { CanaisServico, type Canal, type ProvedorCanal } from './canais.servico.js'
import { FormularioCredencialComponente } from '../integracao/formulario-credencial.componente.js'

/**
 * Cadastro de celular / canal — Meta (oficial) e não-oficiais (PlugZapi + futuros).
 *
 * ⚠️ O formulário é DESENHADO do catálogo de provedores (`/v1/canais/provedores`),
 * como a tela de ERP. Provedor novo entra no catálogo e aparece aqui sem tocar
 * neste componente. O aviso de RISCO do não-oficial aparece em destaque (ADR-021).
 */
@Component({
  selector: 'app-canais',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormularioCredencialComponente],
  template: `
    <header class="cabecalho">
      <div>
        <h1>Números de WhatsApp</h1>
        <p class="sub">Conecte números oficiais (Meta) e não-oficiais. O cliente escolhe por qual caminho falar.</p>
      </div>
      @if (servico.estado() === 'pronto' && !servico.vazio()) {
        <button class="btn btn--primario" (click)="abrir()">Conectar número</button>
      }
    </header>

    @switch (servico.estado()) {
      @case ('carregando') { <div class="bloco" aria-busy="true"><div class="esqueleto"></div></div> }
      @case ('sem_permissao') { <div class="bloco aviso"><h2>Sem acesso aos canais</h2></div> }
      @case ('erro') { <div class="bloco aviso"><h2>Não foi possível carregar</h2>
        <p>{{ servico.erro() }}</p><button class="btn btn--secundario" (click)="servico.carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (servico.vazio()) {
          <div class="bloco vazio">
            <h2>Nenhum número conectado</h2>
            <p>Conecte um número oficial (Meta) ou não-oficial (PlugZapi) para começar a conversar.</p>
            <button class="btn btn--primario" (click)="abrir()">Conectar meu primeiro número</button>
          </div>
        } @else {
          <!-- Saúde da frota (EP-03): o que exige olho agora. -->
          @if (servico.saude(); as s) {
            <div class="saude">
              <div class="metrica">
                <span class="rot">Entrega (24h)</span>
                @if (s.entrega.amostras === 0) {
                  <span class="val neutro">— sem envios</span>
                } @else {
                  <span class="val" [class.ruim]="(s.entrega.taxa ?? 1) < 0.7">
                    {{ pct(s.entrega.taxa) }} <small>({{ s.entrega.falha }} falhas / {{ s.entrega.amostras }})</small>
                  </span>
                }
              </div>
              <div class="metrica">
                <span class="rot">Alertas abertos</span>
                <span class="val" [class.ruim]="s.alertasAbertos > 0">{{ s.alertasAbertos }}</span>
              </div>
            </div>
          }
          <ul class="lista">
            @for (c of servico.canais(); track c.id) {
              <li class="canal" [class]="'canal--' + c.estado">
                <div class="linha">
                  <div>
                    <h2>{{ c.nomeAmigavel }}</h2>
                    <span class="tags">
                      <span class="tag" [class.oficial]="ehOficial(c)">{{ ehOficial(c) ? 'Oficial (Meta)' : 'Não-oficial' }}</span>
                      <span class="tag prov">{{ nomeProvedor(c.provedor) }}</span>
                      @if (!ehOficial(c)) { <span class="tag risco">⚠️ risco de banimento</span> }
                    </span>
                  </div>
                  <span class="selo">{{ rotuloEstado(c.estado) }}</span>
                </div>
                @if (c.estado === 'desconectado' && c.ultimoErro) {
                  <p class="err">{{ c.ultimoErro }}</p>
                }
                <div class="acoes">
                  <button class="btn btn--secundario" (click)="testar(c)" [disabled]="servico.testando().has(c.id)">
                    {{ servico.testando().has(c.id) ? 'Testando…' : 'Testar conexão' }}
                  </button>
                  @if (!ehOficial(c)) {
                    @if (servico.aquecimento()[c.id]?.emAquecimento) {
                      <span class="aquec">🔥 Aquecimento dia {{ servico.aquecimento()[c.id]!.dia }} · hoje {{ servico.aquecimento()[c.id]!.usadoHoje }}/{{ servico.aquecimento()[c.id]!.limiteHoje }}</span>
                    } @else {
                      <button class="btn btn--secundario" (click)="servico.iniciarAquecimento(c.id)">Iniciar aquecimento</button>
                    }
                  }
                </div>
                @if (resultado()[c.id]; as r) {
                  <p class="resultado" [class.ok]="r.conectado" role="status">
                    {{ r.conectado ? '✅ Conectado' : '⚠️ ' + (r.detalhe || 'Desconectado') }}
                    <!-- ⚠️ "Conectado" sem carimbo de hora é afirmação sem prazo
                         de validade: no incidente de 24/ago a tela dizia
                         "Conectado" com o número fora do ar havia horas. -->
                    <span class="quando">· verificado {{ verificadoEm()[c.id] }}</span>
                  </p>
                }

                <!-- Reconexão por QR: só no não-oficial, que é quem tem sessão
                     para restabelecer. No oficial, reconectar é trocar o token.
                     SEMPRE disponível, não só quando o sistema já sabe que caiu:
                     antes o botão dependia do estado ser desconectado, e isso era
                     circular — quem está com o WhatsApp fora do ar ficava
                     esperando o produto descobrir para poder consertar. Ação de
                     recuperação não depende do diagnóstico. -->
                @if (!ehOficial(c)) {
                  <div class="reconectar">
                    <button class="btn"
                            [class.btn--primario]="c.estado === 'desconectado'"
                            [class.btn--secundario]="c.estado !== 'desconectado'"
                            (click)="pedirQr(c.id)" [disabled]="buscandoQr() === c.id">
                      {{ buscandoQr() === c.id ? 'Gerando…'
                         : c.estado === 'desconectado' ? '📱 Reconectar por QR' : '📱 Conectar outro aparelho' }}
                    </button>
                    @if (qr()[c.id]; as q) {
                      @if (q.imagem) {
                        <div class="qr">
                          <img [src]="q.imagem" alt="QR code para parear o WhatsApp" width="240" height="240" />
                          <p class="passos">
                            No celular deste número: <strong>WhatsApp → Aparelhos conectados →
                            Conectar aparelho</strong>, e aponte para o código.
                          </p>
                          <!-- ⚠️ O QR expira em segundos e muda a cada leitura;
                               por isso o botão de gerar outro fica ao lado. -->
                          <p class="expira">O código expira rápido. Se não ler a tempo, gere outro.</p>
                        </div>
                      } @else {
                        <p class="resultado" role="status">⚠️ {{ q.erro }}</p>
                      }
                    }
                  </div>
                }
              </li>
            }
          </ul>
        }
      }
    }

    @if (editando(); as ed) {
      <div class="painel" role="dialog" aria-modal="true" aria-labelledby="tp">
        <h2 id="tp">Conectar número</h2>

        <label class="campo">
          <span class="rotulo">Tipo de número</span>
          <select [value]="ed.provedor" (change)="trocarProvedor($event)">
            @for (p of servico.provedores(); track p.codigo) {
              <option [value]="p.codigo">{{ p.nome }}</option>
            }
          </select>
          <span class="ajuda">{{ provedorAtual()?.descricao }}</span>
        </label>

        <!-- ⚠️ Aviso de risco do não-oficial em DESTAQUE (ADR-021). -->
        @if (provedorAtual()?.aviso; as aviso) {
          <p class="aviso-risco">{{ aviso }}</p>
        }

        <label class="campo">
          <span class="rotulo">Como chamar este número</span>
          <input [value]="ed.nome" (input)="nomeMudou($event)" placeholder="Ex.: WhatsApp da loja" />
          <span class="ajuda">{{ erros()['nomeAmigavel'] ?? 'Aparece nas telas e mensagens do sistema.' }}</span>
        </label>

        @if (provedorAtual(); as p) {
          <app-formulario-credencial [esquema]="p.esquemaCredencial" [erros]="erros()"
                                     (mudou)="credencialMudou($event)" />
        }

        @if (erroGeral(); as m) { <p class="erro-geral" role="alert">{{ m }}</p> }

        <div class="acoes">
          <button class="btn btn--secundario" (click)="fechar()">Cancelar</button>
          <button class="btn btn--primario" (click)="salvar()" [disabled]="salvando()">
            {{ salvando() ? 'Salvando…' : 'Salvar e testar' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .aquec { font-size: 12px; color: var(--texto-secundario); align-self: center; }
    .saude { display: flex; gap: var(--espacamento-6); padding: var(--espacamento-3) var(--espacamento-4);
      margin-bottom: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .saude .metrica { display: flex; flex-direction: column; gap: 2px; }
    .saude .rot { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); }
    .saude .val { font-size: 18px; color: var(--texto); font-variant-numeric: tabular-nums; }
    .saude .val small { font-size: 12px; color: var(--texto-suave); }
    .saude .val.ruim { color: var(--erro); }
    .saude .val.neutro { font-size: 14px; color: var(--texto-suave); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-6); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .vazio, .aviso { text-align: center; } .bloco p { color: var(--texto-secundario); margin: 0 auto var(--espacamento-4); max-width: 44ch; }
    .esqueleto { height: 60px; background: var(--superficie); border-radius: var(--raio-controle); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .canal { padding: var(--espacamento-4); border: 1px solid var(--borda); border-left: 3px solid var(--borda-forte); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .canal--conectado { border-left-color: var(--rfv-cliente-fiel); }
    .canal--desconectado { border-left-color: var(--erro); }
    .canal--conectando { border-left-color: var(--atencao); }
    .linha { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-3); }
    .canal h2 { margin: 0 0 var(--espacamento-1); font-size: 15px; color: var(--texto); }
    .tags { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .tag { font-size: 11px; padding: 1px 6px; border-radius: var(--raio-controle); border: 1px solid var(--borda); color: var(--texto-secundario); background: var(--superficie); }
    .tag.oficial { color: var(--sucesso); border-color: var(--sucesso); }
    .tag.risco { color: var(--erro); border-color: var(--erro); }
    .selo { font-size: 12px; color: var(--texto-secundario); white-space: nowrap; }
    .err { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--erro); }
    .acoes { display: flex; gap: var(--espacamento-2); margin-top: var(--espacamento-3); }
    .reconectar { margin-top: var(--espacamento-3); }
    .quando { color: var(--texto-suave); font-size: 12px; }
    .qr { margin-top: var(--espacamento-3); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .qr img { display: block; margin: 0 auto var(--espacamento-3); border-radius: var(--raio-controle); }
    .qr .passos { margin: 0; font-size: 13px; color: var(--texto); }
    .qr .expira { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); }
    .resultado { margin: var(--espacamento-3) 0 0; font-size: 13px; color: var(--erro); }
    .resultado.ok { color: var(--sucesso); }
    .painel { margin-top: var(--espacamento-6); padding: var(--espacamento-6); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); box-shadow: var(--elevacao-modal); }
    .painel h2 { margin: 0 0 var(--espacamento-4); font-size: 16px; }
    .campo { display: grid; gap: var(--espacamento-1); margin-bottom: var(--espacamento-4); }
    .rotulo { font-weight: 500; font-size: 13px; color: var(--texto); }
    .ajuda { font-size: 12px; color: var(--texto-suave); }
    select, .campo input { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .aviso-risco { padding: var(--espacamento-3); border: 1px solid var(--erro); border-radius: var(--raio-controle); background: var(--superficie); color: var(--erro); font-size: 13px; margin: 0 0 var(--espacamento-4); }
    .erro-geral { color: var(--erro); font-size: 13px; }
  `,
})
export class CanaisPagina implements OnInit {
  readonly servico = inject(CanaisServico)
  readonly editando = signal<{ provedor: string; nome: string } | null>(null)
  readonly credencial = signal<Record<string, string>>({})
  readonly erros = signal<Record<string, string>>({})
  readonly erroGeral = signal<string | null>(null)
  readonly salvando = signal(false)
  readonly resultado = signal<Record<string, { conectado: boolean; detalhe?: string }>>({})
  readonly #http = inject(HttpClient)
  /** Hora da última verificação, por canal — o carimbo ao lado do estado. */
  readonly verificadoEm = signal<Record<string, string>>({})
  readonly qr = signal<Record<string, { imagem?: string; erro?: string }>>({})
  readonly buscandoQr = signal<string | null>(null)

  /**
   * Busca o QR sob demanda. ⚠️ Nunca guardado: o código expira em segundos e
   * muda a cada leitura — servir um QR salvo seria servir um código morto.
   */
  async pedirQr(canalId: string): Promise<void> {
    this.buscandoQr.set(canalId)
    try {
      const r = await firstValueFrom(
        this.#http.get<{ imagem: string }>(`/v1/canais/${canalId}/qrcode`))
      this.qr.update((a) => ({ ...a, [canalId]: { imagem: r.imagem } }))
      // ⚠️ Detecta a conexão sozinho enquanto o QR está aberto. Pedir ao usuário
      //    que clique em "testar" depois de escanear é obrigá-lo a confirmar algo
      //    que o sistema pode descobrir — e a leitura do QR não avisa ninguém.
      this.#acompanharPareamento(canalId)
    } catch (e) {
      // ⚠️ 409 traz motivo NOMEADO do servidor ("já conectada", "provedor sem
      //    QR") — mostrar "erro ao carregar" desperdiçaria a informação.
      const msg = e instanceof HttpErrorResponse && e.status === 409
        ? String(e.error?.mensagem ?? 'QR indisponível')
        : 'Não foi possível gerar o QR. Tente de novo.'
      this.qr.update((a) => ({ ...a, [canalId]: { erro: msg } }))
    } finally {
      this.buscandoQr.set(null)
    }
  }

  readonly provedorAtual = computed(() => {
    const ed = this.editando()
    return ed ? this.servico.provedores().find((p) => p.codigo === ed.provedor) : undefined
  })

  ngOnInit(): void {
    void this.servico.carregar().then(() => {
      // Aquecimento por número (só faz sentido no não-oficial).
      for (const c of this.servico.canais()) {
        if (c.tipo !== 'whatsapp_oficial') void this.servico.carregarAquecimento(c.id)
      }
    })
  }

  pct(taxa: number | null): string { return taxa === null ? '—' : `${Math.round(taxa * 100)}%` }

  ehOficial(c: Canal): boolean { return c.tipo === 'whatsapp_oficial' }
  nomeProvedor(cod: string | null): string {
    return this.servico.provedores().find((p) => p.codigo === cod)?.nome ?? (cod ?? '—')
  }
  rotuloEstado(e: string): string {
    return e === 'conectado' ? 'Conectado' : e === 'desconectado' ? 'Desconectado' : 'Aguardando teste'
  }

  abrir(): void {
    this.limpar()
    this.editando.set({ provedor: this.servico.provedores()[0]?.codigo ?? '', nome: '' })
  }
  fechar(): void { this.editando.set(null); this.limpar() }
  private limpar(): void { this.credencial.set({}); this.erros.set({}); this.erroGeral.set(null) }

  trocarProvedor(e: Event): void {
    // ⚠️ Trocar de provedor limpa a credencial: os campos são outros.
    this.credencial.set({}); this.erros.set({})
    this.editando.update((ed) => (ed ? { ...ed, provedor: (e.target as HTMLSelectElement).value } : ed))
  }
  nomeMudou(e: Event): void {
    this.editando.update((ed) => (ed ? { ...ed, nome: (e.target as HTMLInputElement).value } : ed))
  }
  credencialMudou(v: Record<string, string>): void { this.credencial.set(v) }

  async salvar(): Promise<void> {
    const ed = this.editando()
    if (!ed) return
    this.salvando.set(true); this.erros.set({}); this.erroGeral.set(null)
    try {
      const r = await this.servico.criar({ provedor: ed.provedor, nomeAmigavel: ed.nome, credencial: this.credencial() })
      if (!r.ok) {
        this.erros.set(r.erro.detalhe?.campos ?? (r.erro.detalhe?.campo ? { [r.erro.detalhe.campo]: r.erro.mensagem } : {}))
        if (!r.erro.detalhe?.campos && !r.erro.detalhe?.campo) this.erroGeral.set(r.erro.mensagem)
        return
      }
      this.editando.set(null); this.limpar()
      // Salvar e testar num gesto só — salvar sem testar deixa achando que conectou.
      await this.testar({ id: r.id } as Canal)
    } finally {
      this.salvando.set(false)
    }
  }

  /**
   * Enquanto o QR está na tela, pergunta ao servidor se já pareou.
   *
   * ⚠️ Para sozinho: 20 tentativas de 3s cobrem a vida útil do QR com folga, e um
   * laço sem fim continuaria batendo no fornecedor com a aba esquecida aberta.
   */
  #acompanharPareamento(canalId: string): void {
    let tentativas = 0
    const timer = setInterval(() => {
      if (++tentativas > 20 || !this.qr()[canalId]?.imagem) { clearInterval(timer); return }
      void this.servico.testar(canalId).then((r) => {
        this.resultado.update((a) => ({ ...a, [canalId]: r }))
        if (r.conectado) {
          clearInterval(timer)
          this.qr.update((a) => ({ ...a, [canalId]: {} }))   // some com o QR
          void this.servico.carregar()                       // recarrega o estado
        }
      })
    }, 3000)
  }

  async testar(c: Canal): Promise<void> {
    const r = await this.servico.testar(c.id)
    this.resultado.update((a) => ({ ...a, [c.id]: r }))
    // ⚠️ O carimbo é do momento da RESPOSTA, não do clique: o que interessa é
    //    quando o fornecedor confirmou, não quando alguém pediu.
    const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    this.verificadoEm.update((a) => ({ ...a, [c.id]: `às ${agora}` }))
  }
}
