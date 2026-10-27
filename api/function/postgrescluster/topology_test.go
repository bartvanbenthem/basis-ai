package postgrescluster

import (
	"reflect"
	"testing"
)

const (
	ams = "onprem-ams"
	rtm = "si-ske-demo"
)

// Two members: orders-db in rtm (protected), orders-db-onprem-ams in ams (recovery).
func twoSites(protected, recovery clusterStatus) []topologyMember {
	return []topologyMember{
		{Location: rtm, Topology: "orders-db", Status: protected},
		{Location: ams, Topology: "orders-db-onprem-ams", Status: recovery},
	}
}

func TestPlace(t *testing.T) {
	cases := map[string]struct {
		members                   []topologyMember
		target, prev, mode, token string
		wantCurrent, wantToken    string
		wantWaiting               bool
		want                      map[string]MemberPlacement
	}{
		"single site": {
			members: []topologyMember{{Location: rtm, Topology: "orders-db"}},
			target:  rtm, prev: rtm, mode: Switchover,
			wantCurrent: rtm,
			want:        map[string]MemberPlacement{rtm: {Role: RolePrimary, Primary: "orders-db", Source: "orders-db"}},
		},
		"steady, replica cluster follows the primary": {
			members: twoSites(clusterStatus{}, clusterStatus{}),
			target:  rtm, prev: rtm, mode: Switchover,
			wantCurrent: rtm,
			want: map[string]MemberPlacement{
				rtm: {Role: RolePrimary, Primary: "orders-db", Source: "orders-db-onprem-ams"},
				ams: {Role: RoleReplica, Primary: "orders-db", Source: "orders-db"},
			},
		},
		"steady after a promotion keeps the token": {
			members: twoSites(clusterStatus{}, clusterStatus{LastPromotionToken: "t1"}),
			target:  ams, prev: ams, mode: Switchover, token: "t1",
			wantCurrent: ams, wantToken: "t1",
			want: map[string]MemberPlacement{
				rtm: {Role: RoleReplica, Primary: "orders-db-onprem-ams", Source: "orders-db-onprem-ams"},
				ams: {Role: RolePrimary, Primary: "orders-db-onprem-ams", Source: "orders-db", PromotionToken: "t1"},
			},
		},
		"switchover waits for the demotion token": {
			members: twoSites(clusterStatus{}, clusterStatus{}),
			target:  ams, prev: rtm, mode: Switchover,
			wantCurrent: rtm, wantWaiting: true,
			want: map[string]MemberPlacement{
				// The old primary is demoted: it names the target.
				rtm: {Role: RolePrimary, Primary: "orders-db-onprem-ams", Source: "orders-db-onprem-ams"},
				// The target keeps following the old primary until the token is there.
				ams: {Role: RolePromoting, Primary: "orders-db", Source: "orders-db"},
			},
		},
		"switchover ignores a demotion token that was used before": {
			members: twoSites(clusterStatus{DemotionToken: "old"}, clusterStatus{LastPromotionToken: "old"}),
			target:  ams, prev: rtm, mode: Switchover,
			wantCurrent: rtm, wantWaiting: true,
			want: map[string]MemberPlacement{
				rtm: {Role: RolePrimary, Primary: "orders-db-onprem-ams", Source: "orders-db-onprem-ams"},
				ams: {Role: RolePromoting, Primary: "orders-db", Source: "orders-db"},
			},
		},
		"switchover promotes with a fresh demotion token": {
			members: twoSites(clusterStatus{DemotionToken: "new"}, clusterStatus{LastPromotionToken: "old"}),
			target:  ams, prev: rtm, mode: Switchover,
			wantCurrent: ams, wantToken: "new",
			want: map[string]MemberPlacement{
				rtm: {Role: RoleReplica, Primary: "orders-db-onprem-ams", Source: "orders-db-onprem-ams"},
				ams: {Role: RolePrimary, Primary: "orders-db-onprem-ams", Source: "orders-db", PromotionToken: "new"},
			},
		},
		"failover promotes right away, without a token": {
			members: twoSites(clusterStatus{}, clusterStatus{}),
			target:  ams, prev: rtm, mode: Failover,
			wantCurrent: ams,
			want: map[string]MemberPlacement{
				rtm: {Role: RoleReplica, Primary: "orders-db-onprem-ams", Source: "orders-db-onprem-ams"},
				ams: {Role: RolePrimary, Primary: "orders-db-onprem-ams", Source: "orders-db"},
			},
		},
		"switching back waits for the recovery site's demotion token": {
			members: twoSites(clusterStatus{}, clusterStatus{LastPromotionToken: "t1"}),
			target:  rtm, prev: ams, mode: Switchover, token: "t1",
			wantCurrent: ams, wantWaiting: true,
			want: map[string]MemberPlacement{
				rtm: {Role: RolePromoting, Primary: "orders-db-onprem-ams", Source: "orders-db-onprem-ams"},
				ams: {Role: RolePrimary, Primary: "orders-db", Source: "orders-db"},
			},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			p := place(tc.members, tc.target, tc.prev, tc.mode, tc.token)
			if p.Current != tc.wantCurrent || p.Token != tc.wantToken || p.Waiting != tc.wantWaiting {
				t.Errorf("current/token/waiting = %q/%q/%v, want %q/%q/%v",
					p.Current, p.Token, p.Waiting, tc.wantCurrent, tc.wantToken, tc.wantWaiting)
			}
			if !reflect.DeepEqual(p.Members, tc.want) {
				t.Errorf("members:\n got %+v\nwant %+v", p.Members, tc.want)
			}
		})
	}
}
