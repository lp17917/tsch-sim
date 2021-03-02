export class MPL_Seed_Info_Entry {
    constructor(SeedID, MinSequence, Sequence_no_length, Sequence_nos) {
        this.SeedID = SeedID;
        this.MinSequence = MinSequence;
        this.Sequence_no_length = Sequence_no_length;
        this.Sequence_nos = Sequence_nos;

    }


    get_Sequence_nos() {
        const result = this.Sequence_nos;
        return result;
    }

    get_MinSequence() {
        const result = this.MinSequence;
        return result;
    }

}

