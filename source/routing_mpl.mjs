/**
* \file
*         "MPL" routing protocol implementation.
* \author
*         Luke Perera <luke.perera801@gmail.com>
*/

import constants from './constants.mjs';
import config from './config.mjs';
import * as log from './log.mjs';
import * as time from './time.mjs';
import * as pkt from './packet.mjs';
import * as neighbor from './neighbor.mjs';
import { rng } from './random.mjs';
import {assert, id_to_addr, round_to_ms} from './utils.mjs';
import * as utils from "./utils.mjs";
import * as networknode from "./node.mjs";
import * as MPL_Seed_Set from "./MPL_Seed_Set.mjs";
import * as MPL_Buffer_set from "./MPL_Buffer_Set.mjs";
import * as MPL_Seed_Info from "./MPL_Seed_Info.mjs";

/******constants******/

const ALL_MPL_FORWARDERS           = 0x3;
const MPL_IPV6_OPTION              = 0x6D;

function mlog(severity, node, msg) {
    log.log(severity, node, "MPL", msg);
}

/* Initialize the protocol configuration */
export function initialize(network)
{
    const default_config = {
        /*set parameters for the network*/
        /*If false uses reactive forwarding*/
        REACTIVE_FORWARDING: false,

        PROACTIVE_FORWARDING: true,
        /*30 minute lifetime for any seed set entrys*/
        SEED_SET_ENTRY_LIFETIME: 30 * 60,
        /* Minimum i value for trickle timer data messages*/
        DATA_MESSAGE_IMIN: 5,
        /* */
        DATA_MESSAGE_IMAX: 10,
        DATA_MESSAGE_K: 1,
        DATA_MESSAGE_TIMER_EXPIRATIONS: 3,
        CONTROL_MESSAGE_IMIN: 10 * 1,
        CONTROL_MESSAGE_IMAX: 5 * 6,
        CONTROL_MESSAGE_K: 1,
        CONTROL_MESSAGE_TIMER_EXPIRATIONS: 10,
        IS_SEED: true
    };

    //default_config.DATA_MESSAGE_IMAX = default_config.DATA_MESSAGE_IMIN;

    for (const key in default_config) {
        /* set the ones that have not been set from the config file */
        if (!config.hasOwnProperty(key)) {
            config[key] = default_config[key];
        }
    }
    network.set_protocol_handler(constants.PROTO_ICMP6, MPL_IPV6_OPTION,
        function(node, p) { node.routing.control_rx(p); });
}

/*---------------------------------------------------------------------------*/


/* trickle timer for data and control*/
export class MPL
{
    /*Initialise the routing itself*/
    constructor(node) {
        this.node = node;
        /*The address of the local interface*/
        this.AddressSet = id_to_addr(this.node.id);
        /*All of the addresses within the MPL domain*/
        this.MPLInterfaceSet = null;
        /*seed set - sliding window used for getting the sequence numbers*/
        this.Seed_Set = new Map();
        /*needs seed id, Minsequence as a lower bound, lifetime which has the remaining life of an entry*/
        this.Buffered_Set = [];
        /*buffered set stores recent data packets*/
        //if node type sender make seed
        /*has the seed id, sequence no and the data message*/

        if (this.node.config.IS_SEED){
            this.seedid = ~~ ((rng.random()) * 65536);
            mlog(log.DEBUG, this.node,  `Seedid : ${this.seedid}`);
        }


        this.ctrltimer = null;
        this.ctrl_expires = 0;

    }




    start() {
        this.node.has_joined = true;
        /* generate latency for the surrounding nodes */
        /*Add in generation of MPL packets for seeds*/
    }

    add_seed_set_entry(SeedID, MinSequence) {
        mlog(log.WARNING, this.node,  `Adding entry in seedset seedid:${SeedID} MinSequence:${MinSequence}`);
        utils.assert(!this.Seed_Set.has(SeedID), `Entry with Seed ID ${SeedID} already present`);
        let new_seed_entry = new MPL_Seed_Set.MPL_Seed_Set_Entry(SeedID, MinSequence, 0);
        this.Seed_Set.set(SeedID, new_seed_entry);
    }

    get_seed_set_entry(SeedID){
        const result = this.Seed_Set.get(SeedID);
        utils.assert(result !== undefined, `unknown node ID ${SeedID}`);
        return result;
    }

    increment_seed_lifetimes(){
        for (let key of this.Seed_Set){
            key.increment_lifetime();
        }
    }

    expire_seed_set(){
        for (let key of this.Seed_Set) {
            if (key.get_lifetime() >= this.node.config.SEED_SET_ENTRY_LIFETIME) {
                this.remove_seed(key);
            }
        }
    }

    remove_seed(SeedID) {
        let seed_removed = this.Seed_Set.delete(SeedID);
        utils.assert(seed_removed !== false, `${SeedID} did not exist in seed set`);
    }

    find_space() {
        for (let i = 0; i < this.Buffered_Set.length; i++) {
            if (this.Buffered_Set[i].valid === false) { return i; }
        }
        return -1;
    }

    is_highest_sequence_no(seedid){
        let x = 0;
        let xmax = 0;
        for (let i = 0; i < this.Buffered_Set.length; i++) {
            if (xmax < this.Buffered_Set[i].get_SequenceNumber() && this.Buffered_Set[i].SeedID === seedid && this.Buffered_Set[i].valid) {
                x = i;
                xmax = this.Buffered_Set[i].get_SequenceNumber();
            }

        }
        return xmax;
    }

    add_new_buffer_entry(SeedID, SequenceNumber, DataMessage){
        let new_data_entry = new MPL_Buffer_set.MPL_Buffer_Set_Entry(SeedID, SequenceNumber,DataMessage);
        //Check to see if there is a free space in the buffer
        //mlog(log.WARNING, this.node,  `Adding entry in bufferset seedid:${SeedID} sequecenceno:${SequenceNumber}`);

        let space = this.find_space();
        //If the bufferset is full add to the end of the set
        if (space === -1){
            this.Buffered_Set.push(new_data_entry);
            return this.Buffered_Set.length - 1;
        }
        //If there is an unused slot in the bufferset then put the new data entry there
        else {
            this.Buffered_Set[space].writeover(SeedID, SequenceNumber, DataMessage);
            return space;
        }

    }

    sweep_buffer_set(){
        let removed = 0;
        for (let i = 0; i < this.Buffered_Set.length; i++) {
            if (this.Buffered_Set[i].get_SequenceNumber() < this.Seed_Set.get(this.Buffered_Set[i].SeedID).get_MinSequence() && this.Buffered_Set[i].valid) {
                //Buffer set deleted rather than spliced to preserve indices for timers
                this.Buffered_Set[i].set_invalid();
                removed++;
            }

        }

        mlog(log.WARNING, this.node, `sweeping buffer set of node: ${this.node.id} with ${removed} removed`);
    }

    start_new_data_timer(buffer_entry_index){
        mlog(log.DEBUG, this.node,  `Making timer for entry ${buffer_entry_index}`);
        let timer_len = rng.trickle_random(this.node.config.DATA_MESSAGE_IMAX);
        //mlog(log.DEBUG, this.node,  `adding timer to node for time: ${timer_len} to data entry :seedid ${this.Buffered_Set[buffer_entry_index].SeedID} seqno ${this.Buffered_Set[buffer_entry_index].get_SequenceNumber()}`);
        if (this.Buffered_Set[buffer_entry_index].timer === undefined){
            time.remove_timer(this.Buffered_Set[buffer_entry_index].timer);
        }else if (this.Buffered_Set[buffer_entry_index].timer !== null){
            this.Buffered_Set[buffer_entry_index].set_timer(null);
        }
        this.Buffered_Set[buffer_entry_index].set_timer(time.add_timer(timer_len, false, this, function(mpl){mpl.data_timer_expire(buffer_entry_index);}));
    }

    data_timer_expire(buffer_entry_index) {
        this.Buffered_Set[buffer_entry_index].set_timer(null);
        this.Buffered_Set[buffer_entry_index].increment_expirations();
        if (this.Buffered_Set[buffer_entry_index].trickle_E < this.node.config.DATA_MESSAGE_TIMER_EXPIRATIONS && this.Buffered_Set[buffer_entry_index].valid) {
            const timer_length = rng.trickle_random(this.node.config.DATA_MESSAGE_IMAX);
            //mlog(log.DEBUG, this.node,  `timer expired adding new timer: ${timer_length} for seedid: ${this.Buffered_Set[buffer_entry_index].SeedID} seqno:${this.Buffered_Set[buffer_entry_index].get_SequenceNumber()} has ${this.Buffered_Set[buffer_entry_index].trickle_E} expirations`);
            this.Buffered_Set[buffer_entry_index].set_timer(time.add_timer(timer_length, false, this, function(mpl){mpl.data_timer_expire(buffer_entry_index);}));
        }
        else {
            this.Buffered_Set[buffer_entry_index].timer = null;
            this.Buffered_Set[buffer_entry_index].valid = false;
            mlog(log.DEBUG, this.node,  `-------------------------data timer removed for seedid:${this.Buffered_Set[buffer_entry_index].SeedID} seqno:${this.Buffered_Set[buffer_entry_index].get_SequenceNumber()} due to expirations`);
        }

            this.data_message_send(this.Buffered_Set[buffer_entry_index].get_DataMessage());

    }

    start_new_control_timer() {
        const ctrl_timer_length = rng.trickle_random(this.node.config.CONTROL_MESSAGE_IMAX);
        this.ctrltimer = time.add_timer(ctrl_timer_length, false, this, function(mpl) {
            mpl.control_trickle_expire();
        });
    }

    rst_control_trickle() {
        this.ctrl_expires = 0;
        time.remove_timer(this.ctrltimer);
        this.start_new_control_timer();
    }

    control_trickle_expire(){
        this.ctrl_expires = ++this.ctrl_expires;
        time.remove_timer(this.ctrltimer);
        if (!(this.ctrl_expires >= this.node.config.CONTROL_MESSAGE_TIMER_EXPIRATIONS)){
            this.control_message_send();
        }
        this.control_message_send();
    }

    add_set_timers(packet){
        //Add the data entry
        let bufferindex = this.add_new_buffer_entry(packet.seedid,packet.seqnum,packet);
        if (packet.M === 1 && (packet.seqnum - 3) > this.get_seed_set_entry(packet.seedid).get_MinSequence()){
            this.get_seed_set_entry(packet.seedid).increment_MinSequence();
        }
        if (this.node.config.PROACTIVE_FORWARDING){
            //start trickle timer for data message
            this.start_new_data_timer(bufferindex);
        }
        if (this.node.config.REACTIVE_FORWARDING){
            //if not on and not zero start control timer
            //if on reset trickle timer
            //this.start_new_control_timer();
        }
        for (let i = 0; i < this.Buffered_Set.length; i++) {
            mlog(log.WARNING, this.node,  `Buffer entry: ${i} seedid: ${this.Buffered_Set[i].SeedID} seqno: ${this.Buffered_Set[i].get_SequenceNumber()} expirations ${this.Buffered_Set[i].trickle_E} valid: ${this.Buffered_Set[i].valid}`);
        }

        //mlog(log.WARNING, this.node,  `Receiving packet with seedid: ${packet.seedid} and seqno: ${packet.seqnum}`);
        this.sweep_buffer_set();
    }

    data_message_send(packet) {

        //mlog(log.WARNING, this.node, `sending packet: ${packet.seqnum} seedid: ${packet.seedid}`);
        const new_packet = new pkt.Packet(this.node, -1, packet.length);
        new_packet.copy(packet);
        new_packet.seedid = packet.seedid;
        new_packet.msg_type = packet.msg_type;
        new_packet.lasthop_id = this.node.id;
        new_packet.lasthop_addr = this.node.addr;
        new_packet.nexthop_id = constants.BROADCAST_ID;
        if (new_packet.nexthop_id <= 0) {
            new_packet.nexthop_addr = null;}
        new_packet.M = 0;
        if (this.is_highest_sequence_no(new_packet.seedid) === new_packet.seqnum){
            new_packet.M = 1;
        }

        this.node.add_packet(new_packet);

    }

    control_message_send(){
        let seeds = this.Seed_Set;
        this.control_data = new Map();
        for (let key of this.Seed_Set) {
            let buffered_seq_nos = [];
            let maxseqno = this.is_highest_sequence_no(key);
            for (let j = key.get_MinSequence(); j <= maxseqno; j++){
                buffered_seq_nos.push(false);
            }
            for (let i = 0; i < this.Buffered_Set.length; i++) {
                if (this.Buffered_Set[i].SeedID === key && this.Buffered_Set[i].valid){
                    buffered_seq_nos[this.Buffered_Set[i].get_SequenceNumber() - key.get_MinSequence] = true;
                }
            }
            let new_seed_info_entry = new MPL_Seed_Info.MPL_Seed_Info_Entry(key, key.get_MinSequence, buffered_seq_nos.length, buffered_seq_nos);
            this.control_data.set(key, new_seed_info_entry);
        }
        const packet = new pkt.Packet(this.node, constants.BROADCAST_ID , this.control_data.size + this.Buffered_Set.length, true);
        packet.packet_protocol = constants.PROTO_ICMP6;
        packet.payload = this.control_data;
        packet.msg_type = MPL_IPV6_OPTION;
        packet.mpltype = 1;
        //mlog(log.DEBUG, this.node, `sending seqno ${packet.seqnum}`);
        this.node.add_packet(packet);
    }


    mpl_seed_gen_packet(packet){
        //mlog(log.WARNING, this.node,  `Generating new packet with seqno: ${packet.seqnum} and seedid: ${this.seedid}`);
        packet.seedid = this.seedid;
        packet.M = 1;
        packet.is_ack_required = false;
        packet.msg_type = MPL_IPV6_OPTION;
        this.check_and_add_data(packet);
    }

    check_and_add_data(packet) {
        let exists = false;
        for (let i = 0; i < this.Buffered_Set.length; i++) {
            if (this.Buffered_Set[i].SeedID === packet.seedid &&  this.Buffered_Set[i].get_SequenceNumber() === packet.seqnum && this.Buffered_Set[i].valid){
                exists = true
            }
        }

        if (!exists && packet.seedid != undefined) {
            //If the packet is in the seed set and more than the min sequence no
            if (((this.Seed_Set.has(packet.seedid)) && (packet.seqnum > this.get_seed_set_entry(packet.seedid).get_MinSequence()))) {
                //mlog(log.DEBUG, this.node,  `Packet seqno ${packet.seqnum} doesn't exist. Adding to data buffer`);
                //reset lifetime for this seeds entry
                this.get_seed_set_entry(packet.seedid).rst_lifetime();
                //add to buffer set-------------------------------------------------
                this.add_set_timers(packet);
                return true;
                //If the packet does not have a respective seed set entry for the id
            } else if (!(this.Seed_Set.has(packet.seedid))) {
                //mlog(log.DEBUG, this.node,  `Packet seqno ${packet.seqnum} doesn't exist. Adding to data buffer`);
                //generate seed set and add to buffer set
                this.add_seed_set_entry(packet.seedid, packet.seqnum)
                this.add_set_timers(packet);
                return true;
            }
        }
        return false;
    }


    control_rx(packet){
        for (let key of packet.payload) {
            let seed_info = packet.payload.get(key);
            //Checks for unreceived data messages and if found resets control timer
            if (!this.Seed_Set.has(key) || seed_info.Sequence_nos[(seed_info.Sequence_no_length - 1)] > this.is_highest_sequence_no()) {
                this.rst_control_trickle();
            }

            if (this.is_highest_sequence_no() > ((seed_info.Sequence_no_length - 1) + key.get_MinSequence())){
                for (let i = 0; i < this.Buffered_Set.length; i++){
                    if (seed_info.SeedID === this.Buffered_Set[i] && this.Buffered_Set[i].SequenceNumber > ((seed_info.Sequence_no_length - 1) + key.get_MinSequence())){
                        this.Buffered_Set[i].trickle_E = 0;
                        if (this.Buffered_Set[i].timer === null){
                            this.start_new_data_timer(i);
                            this.rst_control_trickle();
                        }
                    }
                }
            }

        }



        for (let key of this.Seed_Set){
            if (!packet.payload.has(key)){
                this.rst_control_trickle();
                for (let i = 0; i < this.Buffered_Set.length; i++) {
                    this.Buffered_Set[i].trickle_E = 0;
                }

            }
        }
    }


    packet_rx(packet, new_packet){
        //mlog(log.WARNING, this.node,  `Receiving packet with seedid: ${packet.seedid} and seqno: ${packet.seqnum} M: ${packet.M}`);


        //check it is an mpl packet

        new_packet.seedid = packet.seedid;
        new_packet.M = packet.M;
        new_packet.msg_type = packet.msg_type;
        if (packet.msg_type === MPL_IPV6_OPTION) {
            return this.check_and_add_data(new_packet);
        }
    }

    on_tx(neighbor, packet, is_ok, is_ack_required) {

        /* nothing */
    }

    on_prepare_tx_packet(packet){


    }

    on_forward(packet, newpacket) {
        return false;
    }

    on_new_time_source(old_time_source, new_time_source) {
        this.increment_seed_lifetimes();
        if (new_time_source == null) {
            this.node.routes.remove_default_route();
        } else {
            this.node.routes.add_default_route(new_time_source.id);
        }
        this.expire_seed_set();
    }

    local_repair() {

        this.AddressSet = id_to_addr(this.node.id);
        /*All of the addresses within the MPL domain*/
        this.MPLInterfaceSet = null;
        /*seed set - sliding window used for getting the sequence numbers*/
        this.Seed_Set = new Map();
        /*needs seed id, Minsequence as a lower bound, lifetime which has the remaining life of an entry*/
        this.Buffered_Set = [];
        /*buffered set stores recent data packets*/
        //if node type sender make seed
        /*has the seed id, sequence no and the data message*/

        this.ctrltimer = null;
        this.ctrl_expires = 0;

    }

    is_joined() {
        return this.node.has_joined;
    }

    on_periodic_timer() {
        /* nothing */
    }

    stats_get() {
        return {
            routing_tx: 0,
            routing_rx: 0,
            routing_join_time_sec: 0,
            routing_num_parent_changes : 1
        };
    }
}
