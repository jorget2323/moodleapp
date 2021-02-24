// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, Optional, OnInit, OnDestroy, ViewChild, AfterViewInit } from '@angular/core';
import { ActivatedRoute, ActivatedRouteSnapshot, Params } from '@angular/router';
import { IonContent } from '@ionic/angular';
import { CoreCourseModuleMainActivityComponent } from '@features/course/classes/main-activity-component';
import {
    AddonModForum,
    AddonModForumData,
    AddonModForumProvider,
    AddonModForumSortOrder,
    AddonModForumDiscussion,
} from '@addons/mod/forum/services/forum.service';
import { AddonModForumOffline, AddonModForumOfflineDiscussion } from '@addons/mod/forum/services/offline.service';
import { ModalController, PopoverController, Translate } from '@singletons';
import { CoreCourseContentsPage } from '@features/course/pages/contents/contents';
import { AddonModForumHelper } from '@addons/mod/forum/services/helper.service';
import { CoreGroups, CoreGroupsProvider } from '@services/groups';
import { CoreEvents, CoreEventObserver } from '@singletons/events';
import { AddonModForumSyncProvider } from '@addons/mod/forum/services/sync.service';
import { CoreSites } from '@services/sites';
import { CoreUser } from '@features/user/services/user';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreUtils } from '@services/utils/utils';
import { CoreCourse } from '@features/course/services/course';
import { CorePageItemsListManager } from '@classes/page-items-list-manager';
import { CoreSplitViewComponent } from '@components/split-view/split-view';
import { AddonModForumDiscussionOptionsMenuComponent } from '../discussion-options-menu/discussion-options-menu';
import { AddonModForumSortOrderSelectorComponent } from '../sort-order-selector/sort-order-selector';
import { CoreScreen } from '@services/screen';
import { CoreArray } from '@singletons/array';

/**
 * Component that displays a forum entry page.
 */
@Component({
    selector: 'addon-mod-forum-index',
    templateUrl: 'index.html',
    styleUrls: ['index.scss'],
})
export class AddonModForumIndexComponent extends CoreCourseModuleMainActivityComponent implements OnInit, AfterViewInit, OnDestroy {

    @ViewChild(CoreSplitViewComponent) splitView!: CoreSplitViewComponent;

    component = AddonModForumProvider.COMPONENT;
    moduleName = 'forum';
    descriptionNote?: string;
    forum?: AddonModForumData;
    canLoadMore = false;
    loadMoreError = false;
    discussions: AddonModForumDiscussionsManager;
    canAddDiscussion = false;
    addDiscussionText!: string;
    availabilityMessage: string | null = null;
    sortingAvailable!: boolean;
    sortOrders: AddonModForumSortOrder[] = [];
    selectedSortOrder: AddonModForumSortOrder | null = null;
    sortOrderSelectorExpanded = false;
    canPin = false;

    protected syncEventName = AddonModForumSyncProvider.AUTO_SYNCED;
    protected page = 0;
    trackPosts = false;
    protected usesGroups = false;
    protected syncManualObserver?: CoreEventObserver; // It will observe the sync manual event.
    protected replyObserver?: CoreEventObserver;
    protected newDiscObserver?: CoreEventObserver;
    protected viewDiscObserver?: CoreEventObserver;
    protected changeDiscObserver?: CoreEventObserver;

    hasOfflineRatings?: boolean;
    protected ratingOfflineObserver: any;
    protected ratingSyncObserver: any;

    constructor(
        route: ActivatedRoute,
        @Optional() protected content?: IonContent,
        @Optional() courseContentsPage?: CoreCourseContentsPage,
    ) {
        super('AddonModForumIndexComponent', content, courseContentsPage);

        this.discussions = new AddonModForumDiscussionsManager(
            route.component,
            this,
            courseContentsPage ? 'mod_forum/' : '',
        );
    }

    /**
     * Component being initialized.
     */
    async ngOnInit(): Promise<void> {
        this.addDiscussionText = Translate.instance.instant('addon.mod_forum.addanewdiscussion');
        this.sortingAvailable = AddonModForum.instance.isDiscussionListSortingAvailable();
        this.sortOrders = AddonModForum.instance.getAvailableSortOrders();

        await super.ngOnInit();

        // Refresh data if this forum discussion is synchronized from discussions list.
        this.syncManualObserver = CoreEvents.on(AddonModForumSyncProvider.MANUAL_SYNCED, (data) => {
            this.autoSyncEventReceived(data);
        }, this.siteId);

        // Listen for discussions added. When a discussion is added, we reload the data.
        this.newDiscObserver = CoreEvents.on(
            AddonModForumProvider.NEW_DISCUSSION_EVENT,
            this.eventReceived.bind(this, true),
        );
        this.replyObserver = CoreEvents.on(
            AddonModForumProvider.REPLY_DISCUSSION_EVENT,
            this.eventReceived.bind(this, false),
        );
        this.changeDiscObserver = CoreEvents.on(AddonModForumProvider.CHANGE_DISCUSSION_EVENT, (data: any) => {
            if ((this.forum && this.forum.id === data.forumId) || data.cmId === this.module!.id) {
                AddonModForum.instance.invalidateDiscussionsList(this.forum!.id).finally(() => {
                    if (data.discussionId) {
                        // Discussion changed, search it in the list of discussions.
                        const discussion = this.discussions.items.find(
                            (disc) => this.discussions.isOnlineDiscussion(disc) && data.discussionId == disc.discussion,
                        ) as AddonModForumDiscussion;

                        if (discussion) {
                            if (typeof data.locked != 'undefined') {
                                discussion.locked = data.locked;
                            }
                            if (typeof data.pinned != 'undefined') {
                                discussion.pinned = data.pinned;
                            }
                            if (typeof data.starred != 'undefined') {
                                discussion.starred = data.starred;
                            }

                            this.showLoadingAndRefresh(false);
                        }
                    }

                    if (typeof data.deleted != 'undefined' && data.deleted) {
                        if (data.post.parentid == 0 && CoreScreen.instance.isTablet && !this.discussions.empty) {
                            // Discussion deleted, clear details page.
                            this.discussions.select(this.discussions[0]);
                        }

                        this.showLoadingAndRefresh(false);
                    }
                });
            }
        });
    }

    async ngAfterViewInit(): Promise<void> {
        await this.loadContent(false, true);

        if (!this.forum) {
            return;
        }

        CoreUtils.instance.ignoreErrors(
            AddonModForum.instance
                .logView(this.forum.id, this.forum.name)
                .then(async () => {
                    CoreCourse.instance.checkModuleCompletion(this.courseId!, this.module!.completiondata);

                    return;
                }),
        );

        this.discussions.start(this.splitView);
    }

    /**
     * Component being destroyed.
     */
    ngOnDestroy(): void {
        super.ngOnDestroy();

        this.syncManualObserver && this.syncManualObserver.off();
        this.newDiscObserver && this.newDiscObserver.off();
        this.replyObserver && this.replyObserver.off();
        this.viewDiscObserver && this.viewDiscObserver.off();
        this.changeDiscObserver && this.changeDiscObserver.off();
        this.ratingOfflineObserver && this.ratingOfflineObserver.off();
        this.ratingSyncObserver && this.ratingSyncObserver.off();
    }

    /**
     * Download the component contents.
     *
     * @param refresh Whether we're refreshing data.
     * @param sync If the refresh needs syncing.
     * @param showErrors Wether to show errors to the user or hide them.
     */
    protected async fetchContent(refresh: boolean = false, sync: boolean = false): Promise<void> {
        this.loadMoreError = false;

        const promises: Promise<void>[] = [];

        promises.push(this.fetchForum());
        promises.push(this.fetchSortOrderPreference());

        try {
            await Promise.all(promises);
            await Promise.all([
                this.fetchOfflineDiscussions(),
                this.fetchDiscussions(refresh),
            ]);
        } catch (error) {
            if (refresh) {
                CoreDomUtils.instance.showErrorModalDefault(error, 'addon.mod_forum.errorgetforum', true);

                this.loadMoreError = true; // Set to prevent infinite calls with infinite-loading.
            } else {
                // Get forum failed, retry without using cache since it might be a new activity.
                await this.refreshContent(sync);
            }
        }

        this.fillContextMenu(refresh);
    }

    private async fetchForum(refresh: boolean = false, sync: boolean = false, showErrors: boolean = false): Promise<void> {
        if (!this.courseId || !this.module) {
            return;
        }

        this.loadMoreError = false;

        const promises: Promise<void>[] = [];

        promises.push(
            AddonModForum.instance
                .getForum(this.courseId, this.module.id)
                .then(async (forum) => {
                    this.forum = forum;
                    this.description = forum.intro || this.description;
                    this.availabilityMessage = AddonModForumHelper.instance.getAvailabilityMessage(forum);
                    this.descriptionNote = Translate.instant('addon.mod_forum.numdiscussions', {
                        numdiscussions: forum.numdiscussions,
                    });

                    if (typeof forum.istracked != 'undefined') {
                        this.trackPosts = forum.istracked;
                    }

                    this.dataRetrieved.emit(forum);

                    switch (forum.type) {
                        case 'news':
                        case 'blog':
                            this.addDiscussionText = Translate.instant('addon.mod_forum.addanewtopic');
                            break;
                        case 'qanda':
                            this.addDiscussionText = Translate.instant('addon.mod_forum.addanewquestion');
                            break;
                        default:
                            this.addDiscussionText = Translate.instant('addon.mod_forum.addanewdiscussion');
                    }

                    if (sync) {
                        // Try to synchronize the forum.
                        const updated = await this.syncActivity(showErrors);

                        if (updated) {
                            // Sync successful, send event.
                            CoreEvents.trigger(AddonModForumSyncProvider.MANUAL_SYNCED, {
                                forumId: forum.id,
                                userId: CoreSites.instance.getCurrentSiteUserId(),
                                source: 'index',
                            }, CoreSites.instance.getCurrentSiteId());
                        }
                    }

                    const promises: Promise<void>[] = [];

                    // Check if the activity uses groups.
                    promises.push(
                        // eslint-disable-next-line promise/no-nesting
                        CoreGroups.instance
                            .getActivityGroupMode(this.forum.cmid)
                            .then(async mode => {
                                this.usesGroups = mode === CoreGroupsProvider.SEPARATEGROUPS
                                    || mode === CoreGroupsProvider.VISIBLEGROUPS;

                                return;
                            }),
                    );

                    promises.push(
                        // eslint-disable-next-line promise/no-nesting
                        AddonModForum.instance
                            .getAccessInformation(this.forum.id, { cmId: this.module!.id })
                            .then(async accessInfo => {
                                // Disallow adding discussions if cut-off date is reached and the user has not the
                                // capability to override it.
                                // Just in case the forum was fetched from WS when the cut-off date was not reached but it is now.
                                const cutoffDateReached = AddonModForumHelper.instance.isCutoffDateReached(this.forum!)
                                    && !accessInfo.cancanoverridecutoff;
                                this.canAddDiscussion = !!this.forum?.cancreatediscussions && !cutoffDateReached;

                                return;
                            }),
                    );

                    if (AddonModForum.instance.isSetPinStateAvailableForSite()) {
                        // Use the canAddDiscussion WS to check if the user can pin discussions.
                        promises.push(
                            // eslint-disable-next-line promise/no-nesting
                            AddonModForum.instance
                                .canAddDiscussionToAll(this.forum.id, { cmId: this.module!.id })
                                .then(async response => {
                                    this.canPin = !!response.canpindiscussions;

                                    return;
                                })
                                .catch(async () => {
                                    this.canPin = false;

                                    return;
                                }),
                        );
                    } else {
                        this.canPin = false;
                    }

                    await Promise.all(promises);

                    return;
                }),
        );

        promises.push(this.fetchSortOrderPreference());

        try {
            await Promise.all(promises);
            await Promise.all([
                this.fetchOfflineDiscussions(),
                this.fetchDiscussions(refresh),
            ]);
        } catch (message) {
            if (!refresh) {
                // Get forum failed, retry without using cache since it might be a new activity.
                return this.refreshContent(sync);
            }

            CoreDomUtils.instance.showErrorModalDefault(message, 'addon.mod_forum.errorgetforum', true);

            this.loadMoreError = true; // Set to prevent infinite calls with infinite-loading.
        }

        this.fillContextMenu(refresh);
    }

    /**
     * Convenience function to fetch offline discussions.
     *
     * @return Promise resolved when done.
     */
    protected async fetchOfflineDiscussions(): Promise<void> {
        const forum = this.forum!;
        let offlineDiscussions = await AddonModForumOffline.instance.getNewDiscussions(forum.id);
        this.hasOffline = !!offlineDiscussions.length;

        if (!this.hasOffline) {
            this.discussions.setOfflineDiscussions([]);

            return;
        }

        if (this.usesGroups) {
            offlineDiscussions = await AddonModForum.instance.formatDiscussionsGroups(forum.cmid, offlineDiscussions);
        }

        // Fill user data for Offline discussions (should be already cached).
        const promises = offlineDiscussions.map(async (discussion: any) => {
            if (discussion.parent === 0 || forum.type === 'single') {
                // Do not show author for first post and type single.
                return;
            }

            try {
                const user = await CoreUser.instance.getProfile(discussion.userid, this.courseId, true);

                discussion.userfullname = user.fullname;
                discussion.userpictureurl = user.profileimageurl;
            } catch (error) {
                // Ignore errors.
            }
        });

        await Promise.all(promises);

        // Sort discussion by time (newer first).
        offlineDiscussions.sort((a, b) => b.timecreated - a.timecreated);

        this.discussions.setOfflineDiscussions(offlineDiscussions);
    }

    /**
     * Convenience function to get forum discussions.
     *
     * @param refresh Whether we're refreshing data.
     * @return Promise resolved when done.
     */
    protected async fetchDiscussions(refresh: boolean): Promise<void> {
        const forum = this.forum!;
        this.loadMoreError = false;

        if (refresh) {
            this.page = 0;
        }

        const response = await AddonModForum.instance.getDiscussions(forum.id, {
            cmId: forum.cmid,
            sortOrder: this.selectedSortOrder!.value,
            page: this.page,
        });
        let discussions = response.discussions;

        if (this.usesGroups) {
            discussions = await AddonModForum.instance.formatDiscussionsGroups(forum.cmid, discussions);
        }

        // Hide author for first post and type single.
        if (forum.type === 'single') {
            for (const discussion of discussions) {
                if (discussion.userfullname && discussion.parent === 0) {
                    (discussion as any).userfullname = false;
                    break;
                }
            }
        }

        // If any discussion has unread posts, the whole forum is being tracked.
        if (typeof forum.istracked === 'undefined' && !this.trackPosts) {
            for (const discussion of discussions) {
                if (discussion.numunread > 0) {
                    this.trackPosts = true;
                    break;
                }
            }
        }

        if (this.page === 0) {
            this.discussions.setOnlineDiscussions(discussions);
        } else {
            this.discussions.setItems(this.discussions.items.concat(discussions));
        }

        this.canLoadMore = response.canLoadMore;
        this.page++;

        // Check if there are replies for discussions stored in offline.
        const hasOffline = await AddonModForumOffline.instance.hasForumReplies(forum.id);

        this.hasOffline = this.hasOffline || hasOffline;

        if (hasOffline) {
            // Only update new fetched discussions.
            const promises = discussions.map(async (discussion: any) => {
                // Get offline discussions.
                const replies = await AddonModForumOffline.instance.getDiscussionReplies(discussion.discussion);

                discussion.numreplies = Number(discussion.numreplies) + replies.length;
            });

            await Promise.all(promises);
        }
    }

    /**
     * Convenience function to load more forum discussions.
     *
     * @param infiniteComplete Infinite scroll complete function. Only used from core-infinite-loading.
     * @return Promise resolved when done.
     */
    fetchMoreDiscussions(infiniteComplete?: any): Promise<any> {
        return this.fetchDiscussions(false).catch((message) => {
            CoreDomUtils.instance.showErrorModalDefault(message, 'addon.mod_forum.errorgetforum', true);

            this.loadMoreError = true; // Set to prevent infinite calls with infinite-loading.
        }).finally(() => {
            infiniteComplete && infiniteComplete();
        });
    }

    /**
     * Convenience function to fetch the sort order preference.
     *
     * @return Promise resolved when done.
     */
    protected async fetchSortOrderPreference(): Promise<void> {
        const getSortOrder = async () => {
            if (!this.sortingAvailable) {
                return null;
            }

            const value = await CoreUtils.instance.ignoreErrors(
                CoreUser.instance.getUserPreference(AddonModForumProvider.PREFERENCE_SORTORDER),
            );

            return value ? parseInt(value, 10) : null;
        };

        const value = await getSortOrder();

        this.selectedSortOrder = this.sortOrders.find(sortOrder => sortOrder.value === value) || this.sortOrders[0];
    }

    /**
     * Perform the invalidate content function.
     *
     * @return Resolved when done.
     */
    protected invalidateContent(): Promise<any> {
        const promises: Promise<void>[] = [];

        promises.push(AddonModForum.instance.invalidateForumData(this.courseId!));

        if (this.forum) {
            promises.push(AddonModForum.instance.invalidateDiscussionsList(this.forum.id));
            promises.push(CoreGroups.instance.invalidateActivityGroupMode(this.forum.cmid));
            promises.push(AddonModForum.instance.invalidateAccessInformation(this.forum.id));
        }

        if (this.sortingAvailable) {
            promises.push(CoreUser.instance.invalidateUserPreference(AddonModForumProvider.PREFERENCE_SORTORDER));
        }

        return Promise.all(promises);
    }

    /**
     * Checks if sync has succeed from result sync data.
     *
     * @param result Data returned on the sync function.
     * @return Whether it succeed or not.
     */
    protected hasSyncSucceed(result: any): boolean {
        return result.updated;
    }

    /**
     * Function called when we receive an event of new discussion or reply to discussion.
     *
     * @param isNewDiscussion Whether it's a new discussion event.
     * @param data Event data.
     */
    protected eventReceived(isNewDiscussion: boolean, data: any): void {
        if ((this.forum && this.forum.id === data.forumId) || data.cmId === this.module?.id) {
            this.showLoadingAndRefresh(false).finally(() => {
                // If it's a new discussion in tablet mode, try to open it.
                if (isNewDiscussion && CoreScreen.instance.isTablet) {
                    const discussion = this.discussions.items.find(disc => {
                        if (this.discussions.isOfflineDiscussion(disc)) {
                            return disc.timecreated === data.discTimecreated;
                        }

                        if (this.discussions.isOnlineDiscussion(disc)) {
                            return CoreArray.contains(data.discussionIds, disc.discussion);
                        }

                        return false;
                    });

                    if (discussion || !this.discussions.empty) {
                        this.discussions.select(discussion ?? this.discussions.items[0]);
                    }
                }
            });

            // Check completion since it could be configured to complete once the user adds a new discussion or replies.
            CoreCourse.instance.checkModuleCompletion(this.courseId!, this.module!.completiondata);
        }
    }

    /**
     * Opens the new discussion form.
     *
     * @param timeCreated Creation time of the offline discussion.
     */
    openNewDiscussion(): void {
        this.discussions.select({ newDiscussion: true });
    }

    /**
     * Display the sort order selector modal.
     */
    async showSortOrderSelector(): Promise<void> {
        if (!this.sortingAvailable) {
            return;
        }

        const modal = await ModalController.instance.create({
            component: AddonModForumSortOrderSelectorComponent,
            componentProps: {
                sortOrders: this.sortOrders,
                selected: this.selectedSortOrder!.value,
            },
        });

        modal.present();

        this.sortOrderSelectorExpanded = true;

        const result = await modal.onDidDismiss<AddonModForumSortOrder>();

        this.sortOrderSelectorExpanded = false;

        if (result.data && result.data.value != this.selectedSortOrder?.value) {
            this.selectedSortOrder = result.data;
            this.page = 0;

            try {
                await CoreUser.instance.setUserPreference(AddonModForumProvider.PREFERENCE_SORTORDER, result.data.value.toFixed(0));
                await this.showLoadingAndFetch();
            } catch (error) {
                CoreDomUtils.instance.showErrorModalDefault(error, 'Error updating preference.');
            }
        }
    }

    /**
     * Show the context menu.
     *
     * @param event Click Event.
     * @param discussion Discussion.
     */
    async showOptionsMenu(event: Event, discussion: AddonModForumDiscussion): Promise<void> {
        const popover = await PopoverController.instance.create({
            component: AddonModForumDiscussionOptionsMenuComponent,
            componentProps: {
                discussion,
                forumId: this.forum!.id,
                cmId: this.module!.id,
            },
            event,
        });

        popover.present();

        const result = await popover.onDidDismiss<{ action?: string; value: boolean }>();

        if (result.data && result.data.action) {
            switch (result.data.action) {
                case 'lock':
                    discussion.locked = result.data.value;
                    break;
                case 'pin':
                    discussion.pinned = result.data.value;
                    break;
                case 'star':
                    discussion.starred = result.data.value;
                    break;
                default:
                    break;
            }
        }
    }

}

/**
 * Type to select the new discussion form.
 */
type NewDiscussionForm = { newDiscussion: true };

/**
 * Type of items that can be held by the discussions manager.
 */
type DiscussionItem = AddonModForumDiscussion | AddonModForumOfflineDiscussion | NewDiscussionForm;

/**
 * Discussions manager.
 */
class AddonModForumDiscussionsManager extends CorePageItemsListManager<DiscussionItem> {

    private discussionsPathPrefix: string;
    private component: AddonModForumIndexComponent;

    constructor(pageComponent: unknown, component: AddonModForumIndexComponent, discussionsPathPrefix: string) {
        super(pageComponent);

        this.component = component;
        this.discussionsPathPrefix = discussionsPathPrefix;
    }

    get onlineDiscussions(): AddonModForumDiscussion[] {
        return this.items.filter(discussion => this.isOnlineDiscussion(discussion)) as AddonModForumDiscussion[];
    }

    /**
     * @inheritdoc
     */
    getItemQueryParams(discussion: DiscussionItem): Params {
        return {
            courseId: this.component.courseId,
            cmId: this.component.module!.id,
            forumId: this.component.forum!.id,
            ...(this.isOnlineDiscussion(discussion) ? { discussion, trackPosts: this.component.trackPosts } : {}),
        };
    }

    /**
     * Type guard to infer NewDiscussionForm objects.
     *
     * @param discussion Item to check.
     * @return Whether the item is a new discussion form.
     */
    isNewDiscussionForm(discussion: DiscussionItem): discussion is NewDiscussionForm {
        return 'newDiscussion' in discussion;
    }

    /**
     * Type guard to infer AddonModForumDiscussion objects.
     *
     * @param discussion Item to check.
     * @return Whether the item is an online discussion.
     */
    isOfflineDiscussion(discussion: DiscussionItem): discussion is AddonModForumOfflineDiscussion {
        return !this.isNewDiscussionForm(discussion)
            && !this.isOnlineDiscussion(discussion);
    }

    /**
     * Type guard to infer AddonModForumDiscussion objects.
     *
     * @param discussion Item to check.
     * @return Whether the item is an online discussion.
     */
    isOnlineDiscussion(discussion: DiscussionItem): discussion is AddonModForumDiscussion {
        return 'id' in discussion;
    }

    /**
     * Update online discussion items.
     *
     * @param onlineDiscussions Online discussions
     */
    setOnlineDiscussions(onlineDiscussions: AddonModForumDiscussion[]): void {
        const otherDiscussions = this.items.filter(discussion => !this.isOnlineDiscussion(discussion));

        this.setItems(otherDiscussions.concat(onlineDiscussions));
    }

    /**
     * Update offline discussion items.
     *
     * @param offlineDiscussions Offline discussions
     */
    setOfflineDiscussions(offlineDiscussions: AddonModForumOfflineDiscussion[]): void {
        const otherDiscussions = this.items.filter(discussion => !this.isOfflineDiscussion(discussion));

        this.setItems((offlineDiscussions as DiscussionItem[]).concat(otherDiscussions));
    }

    /**
     * @inheritdoc
     */
    protected getItemPath(discussion: DiscussionItem): string {
        const getRelativePath = () => {
            if (this.isOnlineDiscussion(discussion)) {
                return discussion.id;
            }

            if (this.isOfflineDiscussion(discussion)) {
                return `new/${discussion.timecreated}`;
            }

            return 'new/0';
        };

        return this.discussionsPathPrefix + getRelativePath();
    }

    /**
     * @inheritdoc
     */
    protected getSelectedItemPath(route: ActivatedRouteSnapshot): string | null {
        if (route.params.discussionId) {
            return this.discussionsPathPrefix + route.params.discussionId;
        }

        if (route.params.timeCreated) {
            return this.discussionsPathPrefix + `new/${route.params.timeCreated}`;
        }

        return null;
    }

}
