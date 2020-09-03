/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/extensionsWidgets';
import { Disposable, IDisposable, dispose, toDisposable } from 'vs/base/common/lifecycle';
import { IExtension, IExtensionsWorkbenchService, IExtensionContainer, ExtensionState } from '../common/extensions';
import { append, $, addClass } from 'vs/base/browser/dom';
import * as platform from 'vs/base/common/platform';
import { localize } from 'vs/nls';
import { IExtensionManagementServerService, IExtensionTipsService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ILabelService } from 'vs/platform/label/common/label';
import { extensionButtonProminentBackground, extensionButtonProminentForeground, DisabledLabelAction, ReloadAction } from 'vs/workbench/contrib/extensions/electron-browser/extensionsActions';
import { IThemeService, ITheme } from 'vs/platform/theme/common/themeService';
import { EXTENSION_BADGE_REMOTE_BACKGROUND, EXTENSION_BADGE_REMOTE_FOREGROUND } from 'vs/workbench/common/theme';
import { REMOTE_HOST_SCHEME } from 'vs/platform/remote/common/remoteHosts';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { Emitter, Event } from 'vs/base/common/event';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';

export abstract class ExtensionWidget extends Disposable implements IExtensionContainer {
	private _extension: IExtension;
	get extension(): IExtension { return this._extension; }
	set extension(extension: IExtension) { this._extension = extension; this.update(); }
	update(): void { this.render(); }
	abstract render(): void;
}

export class Label extends ExtensionWidget {

	constructor(
		private element: HTMLElement,
		private fn: (extension: IExtension) => string,
		@IExtensionsWorkbenchService extensionsWorkbenchService: IExtensionsWorkbenchService
	) {
		super();
		this.render();
	}

	render(): void {
		this.element.textContent = this.extension ? this.fn(this.extension) : '';
	}
}

export class InstallCountWidget extends ExtensionWidget {

	constructor(
		private container: HTMLElement,
		private small: boolean,
		@IExtensionsWorkbenchService extensionsWorkbenchService: IExtensionsWorkbenchService
	) {
		super();
		addClass(container, 'extension-install-count');
		this.render();
	}

	render(): void {
		this.container.innerHTML = '';

		if (!this.extension) {
			return;
		}

		const installCount = this.extension.installCount;

		if (installCount === undefined) {
			return;
		}

		let installLabel: string;

		if (this.small) {
			if (installCount > 1000000) {
				installLabel = `${Math.floor(installCount / 100000) / 10}M`;
			} else if (installCount > 1000) {
				installLabel = `${Math.floor(installCount / 1000)}K`;
			} else {
				installLabel = String(installCount);
			}
		}
		else {
			installLabel = installCount.toLocaleString(platform.locale);
		}

		append(this.container, $('span.octicon.octicon-cloud-download'));
		const count = append(this.container, $('span.count'));
		count.textContent = installLabel;
	}
}

export class RatingsWidget extends ExtensionWidget {

	constructor(
		private container: HTMLElement,
		private small: boolean
	) {
		super();
		addClass(container, 'extension-ratings');

		if (this.small) {
			addClass(container, 'small');
		}

		this.render();
	}

	render(): void {
		this.container.innerHTML = '';

		if (!this.extension) {
			return;
		}

		if (this.extension.rating === undefined) {
			return;
		}

		if (this.small && !this.extension.ratingCount) {
			return;
		}

		const rating = Math.round(this.extension.rating * 2) / 2;

		if (this.small) {
			append(this.container, $('span.full.star'));

			const count = append(this.container, $('span.count'));
			count.textContent = String(rating);
		} else {
			for (let i = 1; i <= 5; i++) {
				if (rating >= i) {
					append(this.container, $('span.full.star'));
				} else if (rating >= i - 0.5) {
					append(this.container, $('span.half.star'));
				} else {
					append(this.container, $('span.empty.star'));
				}
			}
		}
		this.container.title = this.extension.ratingCount === 1 ? localize('ratedBySingleUser', "Rated by 1 user")
			: typeof this.extension.ratingCount === 'number' && this.extension.ratingCount > 1 ? localize('ratedByUsers', "Rated by {0} users", this.extension.ratingCount) : localize('noRating', "No rating");
	}
}

export class TooltipWidget extends ExtensionWidget {

	constructor(
		private readonly parent: HTMLElement,
		private readonly disabledLabelAction: DisabledLabelAction,
		private readonly recommendationWidget: RecommendationWidget,
		private readonly reloadAction: ReloadAction,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkbenchEnvironmentService private readonly workbenchEnvironmentService: IWorkbenchEnvironmentService
	) {
		super();
		this._register(Event.any<any>(
			this.disabledLabelAction.onDidChange,
			this.reloadAction.onDidChange,
			this.recommendationWidget.onDidChangeTooltip,
			this.labelService.onDidChangeFormatters
		)(() => this.render()));
	}

	render(): void {
		this.parent.title = '';
		this.parent.removeAttribute('aria-label');
		this.parent.title = this.getTooltip();
		if (this.extension) {
			this.parent.setAttribute('aria-label', localize('extension-arialabel', "{0}. Press enter for extension details.", this.extension.displayName));
		}
	}

	private getTooltip(): string {
		if (!this.extension) {
			return '';
		}
		if (this.reloadAction.enabled) {
			return this.reloadAction.tooltip;
		}
		if (this.disabledLabelAction.label) {
			return this.disabledLabelAction.label;
		}
		if (this.extension.local && this.extension.state === ExtensionState.Installed) {
			if (this.extension.server === this.extensionManagementServerService.remoteExtensionManagementServer) {
				return localize('extension enabled on remote', "Extension is enabled on '{0}'", this.labelService.getHostLabel(REMOTE_HOST_SCHEME, this.workbenchEnvironmentService.configuration.remoteAuthority));
			}
			return localize('extension enabled locally', "Extension is enabled locally.");
		}
		return this.recommendationWidget.tooltip;
	}

}

export class RecommendationWidget extends ExtensionWidget {

	private element?: HTMLElement;
	private disposables: IDisposable[] = [];

	private _tooltip: string;
	get tooltip(): string { return this._tooltip; }
	set tooltip(tooltip: string) {
		if (this._tooltip !== tooltip) {
			this._tooltip = tooltip;
			this._onDidChangeTooltip.fire();
		}
	}
	private _onDidChangeTooltip: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChangeTooltip: Event<void> = this._onDidChangeTooltip.event;

	constructor(
		private parent: HTMLElement,
		@IThemeService private readonly themeService: IThemeService,
		@IExtensionTipsService private readonly extensionTipsService: IExtensionTipsService
	) {
		super();
		this.render();
		this._register(toDisposable(() => this.clear()));
		this._register(this.extensionTipsService.onRecommendationChange(() => this.render()));
	}

	private clear(): void {
		this.tooltip = '';
		this.parent.setAttribute('aria-label', this.extension ? localize('viewExtensionDetailsAria', "{0}. Press enter for extension details.", this.extension.displayName) : '');
		if (this.element) {
			this.parent.removeChild(this.element);
		}
		this.element = undefined;
		this.disposables = dispose(this.disposables);
	}

	render(): void {
		this.clear();
		if (!this.extension) {
			return;
		}
		const extRecommendations = this.extensionTipsService.getAllRecommendationsWithReason();
		if (extRecommendations[this.extension.identifier.id.toLowerCase()]) {
			this.element = append(this.parent, $('div.bookmark'));
			const recommendation = append(this.element, $('.recommendation'));
			append(recommendation, $('span.octicon.octicon-star'));
			const applyBookmarkStyle = (theme: ITheme) => {
				const bgColor = theme.getColor(extensionButtonProminentBackground);
				const fgColor = theme.getColor(extensionButtonProminentForeground);
				recommendation.style.borderTopColor = bgColor ? bgColor.toString() : 'transparent';
				recommendation.style.color = fgColor ? fgColor.toString() : 'white';
			};
			applyBookmarkStyle(this.themeService.getTheme());
			this.themeService.onThemeChange(applyBookmarkStyle, this, this.disposables);
			this.tooltip = extRecommendations[this.extension.identifier.id.toLowerCase()].reasonText;
		}
	}

}

export class RemoteBadgeWidget extends ExtensionWidget {

	private remoteBadge: RemoteBadge | null;
	private disposables: IDisposable[] = [];

	private element: HTMLElement;

	constructor(
		parent: HTMLElement,
		private readonly tooltip: boolean,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this.element = append(parent, $('.extension-remote-badge-container'));
		this.render();
		this._register(toDisposable(() => this.clear()));
	}

	private clear(): void {
		if (this.remoteBadge) {
			this.element.removeChild(this.remoteBadge.element);
			this.remoteBadge.dispose();
		}
		this.remoteBadge = null;
		this.disposables = dispose(this.disposables);
	}

	render(): void {
		this.clear();
		if (!this.extension || !this.extension.local || !this.extension.server) {
			return;
		}
		if (this.extension.server === this.extensionManagementServerService.remoteExtensionManagementServer) {
			this.remoteBadge = this.instantiationService.createInstance(RemoteBadge, this.tooltip);
			append(this.element, this.remoteBadge.element);
		}
	}

	dispose(): void {
		if (this.remoteBadge) {
			this.remoteBadge.dispose();
		}
		super.dispose();
	}
}

class RemoteBadge extends Disposable {

	readonly element: HTMLElement;

	constructor(
		private readonly tooltip: boolean,
		@ILabelService private readonly labelService: ILabelService,
		@IThemeService private readonly themeService: IThemeService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService
	) {
		super();
		this.element = $('div.extension-remote-badge');
		this.render();
	}

	private render(): void {
		append(this.element, $('span.octicon.octicon-remote'));

		const applyBadgeStyle = () => {
			if (!this.element) {
				return;
			}
			const bgColor = this.themeService.getTheme().getColor(EXTENSION_BADGE_REMOTE_BACKGROUND);
			const fgColor = this.themeService.getTheme().getColor(EXTENSION_BADGE_REMOTE_FOREGROUND);
			this.element.style.backgroundColor = bgColor ? bgColor.toString() : '';
			this.element.style.color = fgColor ? fgColor.toString() : '';
		};
		applyBadgeStyle();
		this._register(this.themeService.onThemeChange(() => applyBadgeStyle()));

		if (this.tooltip) {
			const updateTitle = () => {
				if (this.element) {
					this.element.title = localize('remote extension title', "Extension in {0}", this.labelService.getHostLabel(REMOTE_HOST_SCHEME, this.environmentService.configuration.remoteAuthority));
				}
			};
			this._register(this.labelService.onDidChangeFormatters(() => updateTitle()));
			updateTitle();
		}
	}
}