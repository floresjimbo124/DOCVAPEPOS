// Shows a readable message instead of a blank page when a page fails to load.
import { Component, type ReactNode } from 'react'

export class ErrorBox extends Component<{ children: ReactNode; resetKey?: string }, { error?: Error; key?: string }> {
  state: { error?: Error; key?: string } = {}
  static getDerivedStateFromError(error: Error) { return { error } }
  static getDerivedStateFromProps(p: { resetKey?: string }, s: { error?: Error; key?: string }) {
    return p.resetKey !== s.key ? { error: undefined, key: p.resetKey } : null // try again on another page
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="admin-body">
        <p className="error" role="alert">This page couldn't load: {this.state.error.message}</p>
        <button className="btn" onClick={() => this.setState({ error: undefined })}>Try again</button>
      </div>
    )
  }
}
