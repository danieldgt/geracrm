import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CAMADA } from './casca.regras.js'

/**
 * A casca no celular liga as regras puras (casca.regras.ts) ao template. Estes
 * testes leem o fonte para garantir que a ligação existe — as regras sozinhas
 * passam verdes mesmo se o template não as usar.
 */
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ler = (rel: string) => readFileSync(resolve(app, rel), 'utf8')
const casca = ler('nucleo/shell.componente.ts')
const trilho = ler('funcionalidades/atendimento/chat-rail.componente.ts')
const inbox = ler('funcionalidades/atendimento/inbox.pagina.ts')

/** Regras CSS com position: fixed e o z-index delas (null = sem z-index). */
function fixosSemCamada(dir: string, achados: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { fixosSemCamada(resolve(dir, ent.name), achados); continue }
    if (!ent.name.endsWith('.ts') || ent.name.endsWith('.spec.ts')) continue
    // A casca e o trilho são donos das camadas abaixo dos modais.
    if (ent.name === 'shell.componente.ts' || ent.name === 'chat-rail.componente.ts') continue
    const src = readFileSync(resolve(dir, ent.name), 'utf8')
    for (const m of src.matchAll(/([^{}]*)\{([^{}]*position:\s*fixed[^{}]*)\}/g)) {
      const z = /z-index:\s*(\d+)/.exec(m[2] ?? '')
      const seletor = (m[1] ?? '').trim().split('\n').pop()?.trim()
      if (!z || Number(z[1]) < CAMADA.modal) achados.push(`${ent.name}: '${seletor}' z-index ${z?.[1] ?? 'ausente'}`)
    }
  }
  return achados
}

describe('⚠️ Botão flutuante de conversas × modais das telas', () => {
  it('a camada do trilho vem de camadaTrilho(), não de número fixo acima dos modais', () => {
    expect(casca).toContain('[style.--z-trilho]="zTrilho()"')
    expect(casca).toMatch(/app-chat-rail\s*\{[^}]*z-index:\s*var\(--z-trilho/)
  })

  it('todo elemento fixo de tela (modal, fundo, painel) fica no piso dos modais ou acima — cobre o botão', () => {
    const achados = fixosSemCamada(app)
    expect(
      achados,
      `position: fixed abaixo de ${CAMADA.modal} fica SOB o botão flutuante 💬 (z ${CAMADA.trilhoRecolhido}) no celular:\n`
      + achados.join('\n'),
    ).toEqual([])
  })
})

describe('Gaveta fecha ao escolher um item do menu', () => {
  it('⚠️ todo link da gaveta fecha ao tocar — tocar na rota ATUAL não gera NavigationEnd', () => {
    const gaveta = casca.slice(casca.indexOf('<aside'), casca.indexOf('</aside>'))
    const links = gaveta.match(/<a\s[^>]*routerLink[^>]*>/g) ?? []
    expect(links.length).toBeGreaterThan(1)
    for (const a of links) expect(a, a).toContain("mudarGaveta('navegou')")
  })
})

describe('Um ‹ por nível no trilho do celular', () => {
  it('o trilho não desenha ‹ próprio; o cabeçalho dele some no celular', () => {
    expect(trilho).not.toContain('voltar-trilho')
    const celular = trilho.slice(trilho.indexOf('@media (max-width: 719.98px)'))
    expect(celular).toMatch(/\.cab\s*\{\s*display:\s*none|\.cab\s*\{[^}]*display:\s*none|,\s*\.cab\s*\{\s*display:\s*none/)
  })

  it('o ‹ que fecha mora no cabeçalho da lista do inbox, pela regra; o da conversa volta à lista', () => {
    expect(inbox).toContain('voltarNoCabecalhoDaLista(this.celular(), this.noTrilho())')
    expect(inbox).toMatch(/class="voltar fechar-trilho" \(click\)="servico\.fecharRail\(\)"/)
    expect(inbox).toMatch(/class="voltar" \(click\)="servico\.voltarParaLista\(\)"/)
    expect(trilho).toContain('[noTrilho]="true"')
  })
})

describe('Trilho em tela cheia se comporta como diálogo', () => {
  it('⚠️ topo e conteúdo ficam inert com o trilho aberto no celular (não só com a gaveta)', () => {
    expect(casca).toContain('<header class="topo" [attr.inert]="atrasInerte() ? \'\' : null">')
    expect(casca).toContain('<div class="conteudo" [attr.inert]="atrasInerte() ? \'\' : null">')
    expect(casca).toContain('conteudoInerte(this.celular(), this.gavetaAberta(), this.inbox.railAberto())')
  })

  it('o trilho em tela cheia se anuncia como diálogo modal', () => {
    expect(trilho).toContain('[attr.role]="telaCheia() ? \'dialog\' : null"')
    expect(trilho).toContain('[attr.aria-modal]="telaCheia() ? \'true\' : null"')
  })
})
