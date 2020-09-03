/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { GlobalMouseMoveMonitor, IStandardMouseMoveEventData, standardMouseMoveMerger } from 'vs/base/browser/globalMouseMoveMonitor';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import 'vs/css!./lightBulbWidget';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from 'vs/editor/browser/editorBrowser';
import { TextModel } from 'vs/editor/common/model/textModel';
import { CodeActionSet } from 'vs/editor/contrib/codeAction/codeAction';
import { CodeActionsState } from './codeActionModel';

export class LightBulbWidget extends Disposable implements IContentWidget {

	private static readonly _posPref = [ContentWidgetPositionPreference.EXACT];

	private readonly _domNode: HTMLDivElement;
	private readonly _editor: ICodeEditor;

	private readonly _onClick = this._register(new Emitter<{ x: number; y: number; state: CodeActionsState.Triggered }>());
	public readonly onClick = this._onClick.event;

	private _position: IContentWidgetPosition | null;
	private _state: CodeActionsState.State = CodeActionsState.Empty;
	private _futureFixes = new CancellationTokenSource();

	constructor(editor: ICodeEditor) {
		super();
		this._domNode = document.createElement('div');
		this._domNode.className = 'lightbulb-glyph';

		this._editor = editor;
		this._editor.addContentWidget(this);

		this._register(this._editor.onDidChangeModel(_ => this._futureFixes.cancel()));
		this._register(this._editor.onDidChangeModelLanguage(_ => this._futureFixes.cancel()));
		this._register(this._editor.onDidChangeModelContent(_ => {
			// cancel when the line in question has been removed
			const editorModel = this._editor.getModel();
			if (this._state.type !== CodeActionsState.Type.Triggered || !editorModel || this._state.position.lineNumber >= editorModel.getLineCount()) {
				this._futureFixes.cancel();
			}
		}));
		this._register(dom.addStandardDisposableListener(this._domNode, 'mousedown', e => {
			if (this._state.type !== CodeActionsState.Type.Triggered) {
				return;
			}

			// Make sure that focus / cursor location is not lost when clicking widget icon
			this._editor.focus();
			dom.EventHelper.stop(e, true);
			// a bit of extra work to make sure the menu
			// doesn't cover the line-text
			const { top, height } = dom.getDomNodePagePosition(this._domNode);
			const { lineHeight } = this._editor.getConfiguration();

			let pad = Math.floor(lineHeight / 3);
			if (this._position && this._position.position !== null && this._position.position.lineNumber < this._state.position.lineNumber) {
				pad += lineHeight;
			}

			this._onClick.fire({
				x: e.posx,
				y: top + height + pad,
				state: this._state
			});
		}));
		this._register(dom.addDisposableListener(this._domNode, 'mouseenter', (e: MouseEvent) => {
			if ((e.buttons & 1) !== 1) {
				return;
			}
			// mouse enters lightbulb while the primary/left button
			// is being pressed -> hide the lightbulb and block future
			// showings until mouse is released
			this.hide();
			const monitor = new GlobalMouseMoveMonitor<IStandardMouseMoveEventData>();
			monitor.startMonitoring(standardMouseMoveMerger, () => { }, () => {
				monitor.dispose();
			});
		}));
		this._register(this._editor.onDidChangeConfiguration(e => {
			// hide when told to do so
			if (e.contribInfo && !this._editor.getConfiguration().contribInfo.lightbulbEnabled) {
				this.hide();
			}
		}));
	}

	dispose(): void {
		super.dispose();
		this._editor.removeContentWidget(this);
	}

	getId(): string {
		return 'LightBulbWidget';
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		return this._position;
	}

	tryShow(newState: CodeActionsState.Triggered) {
		if (this._position && (!newState.position || this._position.position && this._position.position.lineNumber !== newState.position.lineNumber)) {
			// hide when getting a 'hide'-request or when currently
			// showing on another line
			this.hide();
		} else if (this._futureFixes) {
			// cancel pending show request in any case
			this._futureFixes.cancel();
		}

		this._futureFixes = new CancellationTokenSource();
		const { token } = this._futureFixes;
		this._state = newState;

		const selection = this._state.rangeOrSelection;
		this._state.actions.then(fixes => {
			if (!token.isCancellationRequested && fixes.actions.length > 0 && selection) {
				this._show(fixes);
			} else {
				this.hide();
			}
		}).catch(() => {
			this.hide();
		});
	}

	set title(value: string) {
		this._domNode.title = value;
	}

	get title(): string {
		return this._domNode.title;
	}

	private _show(codeActions: CodeActionSet): void {
		const config = this._editor.getConfiguration();
		if (!config.contribInfo.lightbulbEnabled) {
			return;
		}
		if (this._state.type !== CodeActionsState.Type.Triggered) {
			return;
		}
		const { lineNumber, column } = this._state.position;
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const tabSize = model.getOptions().tabSize;
		const lineContent = model.getLineContent(lineNumber);
		const indent = TextModel.computeIndentLevel(lineContent, tabSize);
		const lineHasSpace = config.fontInfo.spaceWidth * indent > 22;
		const isFolded = (lineNumber: number) => {
			return lineNumber > 2 && this._editor.getTopForLineNumber(lineNumber) === this._editor.getTopForLineNumber(lineNumber - 1);
		};

		let effectiveLineNumber = lineNumber;
		if (!lineHasSpace) {
			if (lineNumber > 1 && !isFolded(lineNumber - 1)) {
				effectiveLineNumber -= 1;
			} else if (!isFolded(lineNumber + 1)) {
				effectiveLineNumber += 1;
			} else if (column * config.fontInfo.spaceWidth < 22) {
				// cannot show lightbulb above/below and showing
				// it inline would overlay the cursor...
				this.hide();
				return;
			}
		}

		this._position = {
			position: { lineNumber: effectiveLineNumber, column: 1 },
			preference: LightBulbWidget._posPref
		};
		dom.toggleClass(this._domNode, 'autofixable', codeActions.hasAutoFix);
		this._editor.layoutContentWidget(this);
	}

	hide(): void {
		this._position = null;
		this._state = CodeActionsState.Empty;
		this._futureFixes.cancel();
		this._editor.layoutContentWidget(this);
	}
}
